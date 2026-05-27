# ACE soccer source adapters

The first adapter targets the `soccerdata` Python package as an internal/no-spend POC.

Install locally when ready to probe live scraper coverage:

```bash
python3 -m pip install soccerdata
python3 -m ml.soccer.sources.cli soccerdata-probe
```

Do not treat scraper output as production/commercial-safe until ToS/legal review is complete.
