-- Retire in-app ROS-AI: remove saved NL report specs, staff help chunk index, and related RBAC keys.

DELETE FROM staff_permission_override
WHERE permission_key IN ('ai_assist', 'ai_reports');

DELETE FROM staff_role_permission
WHERE permission_key IN ('ai_assist', 'ai_reports');

DROP TABLE IF EXISTS ai_saved_report;
DROP TABLE IF EXISTS ai_doc_chunk;

-- No remaining vector columns after ai_doc_chunk removal.
DROP EXTENSION IF EXISTS vector;
