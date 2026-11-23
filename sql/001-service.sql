CREATE EXTENSION IF NOT EXISTS pg_trgm;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='download_submitter') THEN
    CREATE ROLE download_submitter NOLOGIN;
  END IF;
END $$;

CREATE FUNCTION public.match_title(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT trim(regexp_replace(lower(normalize(t, NFKC)), '[^[:alnum:]]+', ' ', 'g')) $$;

CREATE TABLE public.download_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  provider text NOT NULL, item_cap integer NOT NULL CHECK(item_cap>0),
  max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 25)
);
CREATE TABLE public.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), caller text NOT NULL, idem_key text,
  input jsonb NOT NULL, provider text NOT NULL, item_cap integer NOT NULL, max_attempts integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','resolving','needs_selection','processing','completed','partial','failed')),
  selected_id text, metadata jsonb, candidates jsonb NOT NULL DEFAULT '[]', error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(caller,idem_key)
);
CREATE TABLE public.download_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES public.requests,
  imdb_title_id text NOT NULL, metadata jsonb NOT NULL, season integer, episode integer,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retrying','completed','failed')),
  attempts integer NOT NULL DEFAULT 0, progress jsonb, subtitles jsonb, error jsonb, warnings jsonb NOT NULL DEFAULT '[]',
  UNIQUE(request_id,imdb_title_id)
);
CREATE TABLE public.item_attempts (
  item_id uuid NOT NULL REFERENCES public.download_items, number integer NOT NULL,
  status text NOT NULL CHECK(status IN ('processing','completed','retrying','failed','interrupted')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error jsonb,
  PRIMARY KEY(item_id,number)
);
CREATE TABLE public.artifacts (
  item_id uuid NOT NULL REFERENCES public.download_items, path text NOT NULL, type text NOT NULL,
  format text NOT NULL, language text, kind text, PRIMARY KEY(item_id,path)
);

CREATE FUNCTION public.coordinate(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v)='number' THEN v::numeric BETWEEN 0 AND 2147483647 AND trunc(v::numeric)=v::numeric ELSE false END
$$;
CREATE FUNCTION public.normalize_submission(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; e jsonb; normalized jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'title') IS DISTINCT FROM 'string'
    OR length(p->>'title') NOT BETWEEN 1 AND 512 OR public.match_title(p->>'title')=''
    OR p - ARRAY['title','year','seasons'] <> '{}' THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF p ? 'year' AND (NOT public.coordinate(p->'year') OR (p->'year')::numeric NOT BETWEEN 1 AND 9999)
    THEN RAISE EXCEPTION 'INVALID_YEAR' USING ERRCODE='22023'; END IF;
  normalized := jsonb_set(p,'{title}',to_jsonb(trim(regexp_replace(normalize(p->>'title', NFKC),'[[:space:]]+',' ','g'))));
  IF NOT p ? 'seasons' THEN RETURN normalized; END IF;
  IF jsonb_typeof(p->'seasons') <> 'array' OR jsonb_array_length(p->'seasons') NOT BETWEEN 1 AND 1000
    THEN RAISE EXCEPTION 'INVALID_SEASONS' USING ERRCODE='22023'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p->'seasons') LOOP
    IF jsonb_typeof(s)<>'object' OR NOT public.coordinate(s->'season') OR s - ARRAY['season','episodes'] <> '{}'
      THEN RAISE EXCEPTION 'INVALID_SEASON' USING ERRCODE='22023'; END IF;
    IF s ? 'episodes' THEN
      IF jsonb_typeof(s->'episodes')<>'array' OR jsonb_array_length(s->'episodes') NOT BETWEEN 1 AND 10000
        THEN RAISE EXCEPTION 'INVALID_EPISODES' USING ERRCODE='22023'; END IF;
      FOR e IN SELECT value FROM jsonb_array_elements(s->'episodes') LOOP
        IF NOT public.coordinate(e) THEN RAISE EXCEPTION 'INVALID_EPISODE' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN jsonb_set(normalized,'{seasons}',(
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('season',sn,'episodes',eps)) ORDER BY sn)
    FROM (SELECT (s.elem->'season')::integer sn,
      CASE WHEN bool_and(s.elem ? 'episodes') THEN jsonb_agg(DISTINCT episode ORDER BY episode) END eps
      FROM jsonb_array_elements(p->'seasons') s(elem)
      LEFT JOIN LATERAL jsonb_array_elements(s.elem->'episodes') ep(episode) ON true GROUP BY 1) grouped
  ));
END $$;

CREATE FUNCTION public.submit_download(payload jsonb, idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical jsonb := public.normalize_submission(payload); result uuid; original jsonb;
BEGIN
  IF length(idempotency_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_KEY' USING ERRCODE='22023'; END IF;
  INSERT INTO public.requests(caller,idem_key,input,provider,item_cap,max_attempts)
    SELECT session_user,idempotency_key,canonical,provider,item_cap,max_attempts FROM public.download_settings
    ON CONFLICT(caller,idem_key) DO NOTHING RETURNING id INTO result;
  IF result IS NULL THEN
    SELECT id,input INTO STRICT result,original FROM public.requests WHERE caller=session_user AND idem_key=idempotency_key;
    IF original-'title' <> canonical-'title' OR public.match_title(original->>'title') <> public.match_title(canonical->>'title')
      THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='P0409'; END IF;
  ELSE
    PERFORM graphile_worker.add_job('resolve_title',json_build_object('id',result),max_attempts := (SELECT max_attempts FROM public.requests WHERE id=result));
  END IF;
  RETURN result;
END $$;
CREATE FUNCTION public.select_download(job_id uuid, imdb_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.requests;
BEGIN
  SELECT * INTO r FROM public.requests WHERE id=job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND' USING ERRCODE='P0404'; END IF;
  IF r.selected_id=imdb_id THEN RETURN r.id; END IF;
  IF r.status<>'needs_selection' OR imdb_id IS NULL OR NOT r.candidates @> jsonb_build_array(jsonb_build_object('imdbId',imdb_id)) THEN
    RAISE EXCEPTION 'INVALID_SELECTION' USING ERRCODE='P0409'; END IF;
  UPDATE public.requests SET selected_id=imdb_id,status='queued' WHERE id=r.id;
  PERFORM graphile_worker.add_job('resolve_title',json_build_object('id',r.id),max_attempts := r.max_attempts);
  RETURN r.id;
END $$;

CREATE VIEW public.job_status AS
SELECT r.id AS "jobId", r.status, r.input, r.provider, r.metadata, r.candidates, r.error,
  jsonb_build_object('total',i.total,'completed',i.completed,'failed',i.failed,'pending',i.total-i.completed-i.failed) AS counts,
  coalesce(i.items,'[]') AS items
FROM public.requests r CROSS JOIN LATERAL (
  SELECT count(*) total, count(*) FILTER(WHERE d.status='completed') completed, count(*) FILTER(WHERE d.status='failed') failed,
    jsonb_agg(jsonb_build_object('id',d.id,'imdbId',d.imdb_title_id,'metadata',d.metadata,'season',d.season,
      'episode',d.episode,'status',d.status,'attempts',d.attempts,'progress',d.progress,'subtitles',d.subtitles,'error',d.error,
      'warnings', d.warnings, 'history',coalesce((SELECT jsonb_agg(jsonb_build_object('number',h.number,'status',h.status,'startedAt',h.started_at,
        'finishedAt',h.finished_at,'error',h.error) ORDER BY h.number) FROM public.item_attempts h WHERE h.item_id=d.id),'[]'),
      'artifacts',coalesce((SELECT jsonb_agg(to_jsonb(a)-'item_id' ORDER BY a.type DESC,a.path) FROM public.artifacts a WHERE a.item_id=d.id),'[]'))
      ORDER BY d.season,d.episode,d.id) items FROM public.download_items d WHERE d.request_id=r.id
) i;
REVOKE ALL ON FUNCTION public.submit_download(jsonb,text), public.select_download(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_download(jsonb,text), public.select_download(uuid,text) TO download_submitter;
GRANT SELECT ON public.job_status TO download_submitter;
