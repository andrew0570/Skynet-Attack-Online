@echo off
rem Project-local SpacetimeDB CLI: keeps config, keys, and data under .tools\spacetime-root
"%~dp0..\spacetime\spacetimedb-cli.exe" --root-dir "%~dp0..\spacetime-root" %*
