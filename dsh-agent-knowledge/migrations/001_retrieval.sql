CREATE TABLE IF NOT EXISTS knowledge.corpora (
  id text PRIMARY KEY, version integer NOT NULL CHECK (version > 0), digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge.documents (
  corpus_id text NOT NULL REFERENCES knowledge.corpora(id), id text NOT NULL,
  title text NOT NULL, content text NOT NULL, search_vector tsvector NOT NULL,
  PRIMARY KEY(corpus_id,id)
);
CREATE INDEX IF NOT EXISTS knowledge_documents_search ON knowledge.documents USING gin(search_vector);
CREATE TABLE IF NOT EXISTS knowledge.records (
  corpus_id text NOT NULL REFERENCES knowledge.corpora(id), id text NOT NULL,
  title text NOT NULL, attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes)='object'), search_vector tsvector NOT NULL,
  PRIMARY KEY(corpus_id,id)
);
CREATE INDEX IF NOT EXISTS knowledge_records_search ON knowledge.records USING gin(search_vector);
CREATE INDEX IF NOT EXISTS knowledge_records_filters ON knowledge.records USING gin(attributes jsonb_path_ops);
CREATE TABLE IF NOT EXISTS knowledge.entities (
  corpus_id text NOT NULL REFERENCES knowledge.corpora(id), id text NOT NULL,
  name text NOT NULL, type text NOT NULL, description text NOT NULL, name_keys text[] NOT NULL,
  search_vector tsvector NOT NULL, PRIMARY KEY(corpus_id,id)
);
CREATE INDEX IF NOT EXISTS knowledge_entities_search ON knowledge.entities USING gin(search_vector);
CREATE INDEX IF NOT EXISTS knowledge_entities_names ON knowledge.entities USING gin(name_keys);
CREATE TABLE IF NOT EXISTS knowledge.relationships (
  corpus_id text NOT NULL REFERENCES knowledge.corpora(id), id text NOT NULL,
  source_id text NOT NULL, target_id text NOT NULL, relation text NOT NULL, description text NOT NULL,
  PRIMARY KEY(corpus_id,id),
  FOREIGN KEY(corpus_id,source_id) REFERENCES knowledge.entities(corpus_id,id),
  FOREIGN KEY(corpus_id,target_id) REFERENCES knowledge.entities(corpus_id,id)
);
CREATE INDEX IF NOT EXISTS knowledge_relationships_source ON knowledge.relationships(corpus_id,source_id);
CREATE INDEX IF NOT EXISTS knowledge_relationships_target ON knowledge.relationships(corpus_id,target_id);
REVOKE ALL ON ALL TABLES IN SCHEMA knowledge FROM PUBLIC;
