ANALYZE raw_basics;
ANALYZE raw_akas;
ANALYZE raw_ratings;
CREATE TABLE catalog_import.titles AS SELECT b.tconst id, b.titletype type, b.primarytitle title,
 b.startyear::integer AS year,b.runtimeminutes::integer runtime,string_to_array(b.genres,',') genres,
 r.averagerating::float8 rating,r.numvotes::integer votes
 FROM raw_basics b LEFT JOIN raw_ratings r USING(tconst);
ALTER TABLE catalog_import.titles ADD PRIMARY KEY(id), ADD CHECK(id ~ '^tt[0-9]+$');
CREATE TABLE catalog_import.names AS
 WITH eligible AS (SELECT tconst,primarytitle,originaltitle FROM raw_basics WHERE titletype IN ('movie','tvMovie','tvSeries','tvMiniSeries'))
 SELECT DISTINCT id, name FROM (
   SELECT tconst id, public.match_title(primarytitle) name FROM eligible UNION ALL
   SELECT tconst,public.match_title(originaltitle) FROM eligible UNION ALL
   SELECT a.titleid,public.match_title(a.title) FROM raw_akas a JOIN eligible b ON b.tconst=a.titleid
 ) n WHERE name IS NOT NULL AND name<>'';
CREATE INDEX ON catalog_import.names(name);
CREATE INDEX ON catalog_import.names USING gin(name gin_trgm_ops);
CREATE TABLE catalog_import.episodes AS SELECT tconst id,parenttconst parent,seasonnumber::integer season,episodenumber::integer episode FROM raw_episode;
ALTER TABLE catalog_import.episodes ADD PRIMARY KEY(id);
CREATE INDEX ON catalog_import.episodes(parent,season,episode);
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM catalog_import.names) OR NOT EXISTS(SELECT FROM catalog_import.episodes e
 JOIN catalog_import.titles t USING(id) JOIN catalog_import.titles p ON p.id=e.parent WHERE e.season IS NOT NULL AND e.episode IS NOT NULL)
 THEN RAISE EXCEPTION 'Catalog has no searchable titles or linked numbered episodes'; END IF;
END $$;
ANALYZE catalog_import.titles;
ANALYZE catalog_import.names;
ANALYZE catalog_import.episodes;
DO $$ BEGIN IF to_regnamespace('catalog') IS NOT NULL THEN ALTER SCHEMA catalog RENAME TO catalog_old; END IF; END $$;
ALTER SCHEMA catalog_import RENAME TO catalog;
DROP SCHEMA IF EXISTS catalog_old CASCADE;
