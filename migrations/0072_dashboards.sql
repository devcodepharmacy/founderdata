-- Custom dashboards (FounderData Pro, pro/worker/dashboards.ts; docs/MCP.md, "Custom dashboards"): pages of widgets an
-- agent builds over MCP, or the owner arranges in the dashboard. Core holds the table, as for every Pro feature.
--
-- A widget is a saved question for the query engine (pro/worker/query.ts: metrics, dimensions, filters, a period and
-- the sites) plus how to draw it (number, line, bar or table). The dashboard runs each widget when it opens, so a
-- widget never holds numbers and never goes stale. The widgets live as one JSON array on the dashboard's row.
--
-- Rows written (pro/test/cost.test.ts pins them): creating a dashboard 1, any change to it 1 (its name, its widgets,
-- their order), deleting it 1. WITHOUT ROWID keeps the id the only key, so no index entry is written next to the row.

--   name          shown as the page title, at most 80 characters
--   description   one line under the title, NULL for none
--   widgets_json  JSON array of { id, title, view, width, query, note }; at most 24
--   created_by    who made it: 'owner' for the dashboard login, else the API key's name
--   updated_by    who changed it last, in the same form
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  widgets_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
