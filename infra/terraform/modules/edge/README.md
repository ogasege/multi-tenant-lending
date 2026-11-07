# edge

This module provides Route 53 routing for the cells.

- `<region>.<api_domain>` is an alias A record to that cell's ALB. It is the cell's stable URL
  (`CELL_API_BASE_URL`), and the app returns it in 307 and 421 responses.
- `<api_domain>` uses **geolocation** records for first contact: continent AF → af-south-1, EU and GB →
  eu-west-2, the WAEMU countries (SN, CI, ML, BF, NE, TG, BJ, GW) → eu-west-3, and everything else (`*`) →
  `default_region`. Rules for regions without a cell are skipped.
- There is an HTTPS health check per cell on `/health/ready`. An unhealthy cell drops out of the geolocation
  answers, and Route 53 falls back to the broader rule or the default.

Each cell's ACM certificate must cover both `api_domain` and `<region>.<api_domain>`.
