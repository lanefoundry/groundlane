-- Seed MVP search providers

INSERT INTO providers (id, display_name, estimated_cost_per_call_usd, pricing_model, pricing_note, pricing_verified_at) VALUES
  ('tavily',    'Tavily',        0.008, 'per_credit',   '1 credit = $0.008, 1,000 free credits/month', 1726099200000),
  ('exa',       'Exa',           0.005, 'per_request',  '1,000 free requests/month',                   1726099200000),
  ('brave',     'Brave Search',  0.003, 'per_request',  '2,000 free queries/month',                    1726099200000),
  ('serper',    'Serper',        0.004, 'per_request',  '2,500 free queries',                          1726099200000),
  ('serpapi',   'SerpApi',       0.010, 'per_request',  '100 free searches/month',                     1726099200000),
  ('linkup',    'Linkup',        0.005, 'per_credit',   'Free tier available',                         1726099200000),
  ('you',       'You.com',       NULL,  'free',         'Keyless daily MCP profile available',          1726099200000),
  ('firecrawl', 'Firecrawl',     0.010, 'per_credit',   '500 free credits',                            1726099200000);
