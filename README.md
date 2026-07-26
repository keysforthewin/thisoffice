# This Office

A Claude visualizer. Your live Claude Code sessions play out as a 3D office:
prompts arrive on the boss's monitor, tool calls run on the employees' screens,
and the office hires more staff when it gets busy.

![The office](docs/screenshots/office.png)

![A monitor up close](docs/screenshots/monitor.png)

## Run

    docker compose up

Open http://localhost:5173.

## Advanced

Change the ports by setting `WEB_PORT` (the page) and `SERVER_PORT` before
starting:

    WEB_PORT=8080 SERVER_PORT=4700 docker compose up

Characters and furniture are CC0 asset packs — see ATTRIBUTION.md.
