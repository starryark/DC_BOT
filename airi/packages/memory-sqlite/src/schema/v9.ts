export const schemaV9 = `
-- v9: FTS5 Lexical Indexes for memory search (IMP-606)

-- Latin analyzer profile using unicode61
CREATE VIRTUAL TABLE memory_search_latin USING fts5(
  text_content,
  target_table UNINDEXED,
  target_id UNINDEXED,
  tokenize='unicode61'
);

-- CJK analyzer profile using trigram
CREATE VIRTUAL TABLE memory_search_cjk USING fts5(
  text_content,
  target_table UNINDEXED,
  target_id UNINDEXED,
  tokenize='trigram'
);

-- Registry of known analyzer versions
CREATE TABLE memory_search_analyzers(
  profile_id TEXT PRIMARY KEY,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL
);

-- Index Lifecycle Triggers
-- We index into both Latin (unicode61) and CJK (trigram) tables so search can select the correct table at query time based on query script.

-- 1. inbound_event_records
CREATE TRIGGER fts_inbound_ins AFTER INSERT ON inbound_event_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (json_extract(new.payload_json, '$.content'), 'inbound_event_records', new.event_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (json_extract(new.payload_json, '$.content'), 'inbound_event_records', new.event_id);
END;
CREATE TRIGGER fts_inbound_upd AFTER UPDATE ON inbound_event_records BEGIN
  UPDATE memory_search_latin SET text_content = json_extract(new.payload_json, '$.content') WHERE target_table = 'inbound_event_records' AND target_id = old.event_id;
  UPDATE memory_search_cjk SET text_content = json_extract(new.payload_json, '$.content') WHERE target_table = 'inbound_event_records' AND target_id = old.event_id;
END;
CREATE TRIGGER fts_inbound_del AFTER DELETE ON inbound_event_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'inbound_event_records' AND target_id = old.event_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'inbound_event_records' AND target_id = old.event_id;
END;

-- 2. semantic_fact_repository_records
CREATE TRIGGER fts_semantic_ins AFTER INSERT ON semantic_fact_repository_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (new.value, 'semantic_fact_repository_records', new.fact_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (new.value, 'semantic_fact_repository_records', new.fact_id);
END;
CREATE TRIGGER fts_semantic_upd AFTER UPDATE ON semantic_fact_repository_records BEGIN
  UPDATE memory_search_latin SET text_content = new.value WHERE target_table = 'semantic_fact_repository_records' AND target_id = old.fact_id;
  UPDATE memory_search_cjk SET text_content = new.value WHERE target_table = 'semantic_fact_repository_records' AND target_id = old.fact_id;
END;
CREATE TRIGGER fts_semantic_del AFTER DELETE ON semantic_fact_repository_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'semantic_fact_repository_records' AND target_id = old.fact_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'semantic_fact_repository_records' AND target_id = old.fact_id;
END;

-- 3. episodic_repository_records
CREATE TRIGGER fts_episodic_ins AFTER INSERT ON episodic_repository_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (new.summary, 'episodic_repository_records', new.episodic_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (new.summary, 'episodic_repository_records', new.episodic_id);
END;
CREATE TRIGGER fts_episodic_upd AFTER UPDATE ON episodic_repository_records BEGIN
  UPDATE memory_search_latin SET text_content = new.summary WHERE target_table = 'episodic_repository_records' AND target_id = old.episodic_id;
  UPDATE memory_search_cjk SET text_content = new.summary WHERE target_table = 'episodic_repository_records' AND target_id = old.episodic_id;
END;
CREATE TRIGGER fts_episodic_del AFTER DELETE ON episodic_repository_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'episodic_repository_records' AND target_id = old.episodic_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'episodic_repository_records' AND target_id = old.episodic_id;
END;

-- 4. summary_repository_records
CREATE TRIGGER fts_summary_ins AFTER INSERT ON summary_repository_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (new.text, 'summary_repository_records', new.summary_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (new.text, 'summary_repository_records', new.summary_id);
END;
CREATE TRIGGER fts_summary_upd AFTER UPDATE ON summary_repository_records BEGIN
  UPDATE memory_search_latin SET text_content = new.text WHERE target_table = 'summary_repository_records' AND target_id = old.summary_id;
  UPDATE memory_search_cjk SET text_content = new.text WHERE target_table = 'summary_repository_records' AND target_id = old.summary_id;
END;
CREATE TRIGGER fts_summary_del AFTER DELETE ON summary_repository_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'summary_repository_records' AND target_id = old.summary_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'summary_repository_records' AND target_id = old.summary_id;
END;

-- 5. procedural_repository_records
CREATE TRIGGER fts_procedural_ins AFTER INSERT ON procedural_repository_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (new.rule, 'procedural_repository_records', new.proc_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (new.rule, 'procedural_repository_records', new.proc_id);
END;
CREATE TRIGGER fts_procedural_upd AFTER UPDATE ON procedural_repository_records BEGIN
  UPDATE memory_search_latin SET text_content = new.rule WHERE target_table = 'procedural_repository_records' AND target_id = old.proc_id;
  UPDATE memory_search_cjk SET text_content = new.rule WHERE target_table = 'procedural_repository_records' AND target_id = old.proc_id;
END;
CREATE TRIGGER fts_procedural_del AFTER DELETE ON procedural_repository_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'procedural_repository_records' AND target_id = old.proc_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'procedural_repository_records' AND target_id = old.proc_id;
END;

-- 6. output_segment_records
CREATE TRIGGER fts_output_ins AFTER INSERT ON output_segment_records BEGIN
  INSERT INTO memory_search_latin (text_content, target_table, target_id) VALUES (new.text, 'output_segment_records', new.segment_id);
  INSERT INTO memory_search_cjk (text_content, target_table, target_id) VALUES (new.text, 'output_segment_records', new.segment_id);
END;
CREATE TRIGGER fts_output_upd AFTER UPDATE ON output_segment_records BEGIN
  UPDATE memory_search_latin SET text_content = new.text WHERE target_table = 'output_segment_records' AND target_id = old.segment_id;
  UPDATE memory_search_cjk SET text_content = new.text WHERE target_table = 'output_segment_records' AND target_id = old.segment_id;
END;
CREATE TRIGGER fts_output_del AFTER DELETE ON output_segment_records BEGIN
  DELETE FROM memory_search_latin WHERE target_table = 'output_segment_records' AND target_id = old.segment_id;
  DELETE FROM memory_search_cjk WHERE target_table = 'output_segment_records' AND target_id = old.segment_id;
END;
`
