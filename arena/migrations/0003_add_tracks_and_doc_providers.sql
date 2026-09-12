-- Add tracks column and document/extraction providers

ALTER TABLE providers ADD COLUMN tracks TEXT DEFAULT 'search';

-- Update existing providers with correct track assignments
UPDATE providers SET tracks = 'search,extraction' WHERE id IN ('tavily', 'exa', 'linkup', 'you', 'firecrawl', 'tinyfish', 'keenable');
-- brave, serper, serpapi, parallel, searchapi, browserbase stay search-only

-- Add document track providers
INSERT INTO providers (id, display_name, tracks, estimated_cost_per_call_usd, pricing_model, pricing_note, pricing_verified_at) VALUES
  ('anydoc',    'Anydoc (local)',  'document', NULL,  'free',        'Local WASM parser, zero cost',    1726099200000),
  ('docling',   'Docling-serve',   'document', NULL,  'free',        'Self-hosted VLM pipeline (MIT)',   1726099200000),
  ('mineru',    'MinerU Cloud',    'document', 0.020, 'per_request', 'Cloud VLM document parsing',      1726099200000),
  ('ocr-space', 'OCR.space',       'document', NULL,  'free',        '25k free requests/month',         1726099200000),
  ('reducto',   'Reducto',         'document', 0.050, 'per_request', 'Async document processing',       1726099200000);
