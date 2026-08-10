"""
architecture-map.py -- structured data describing every real component of
this system: what it is, what layer it's in, and what it connects to.

This is the ONLY thing a developer edits when adding a new feature. Run
scripts/generate_architecture_map.py afterward to regenerate the diagram --
it will also tell you if you forgot to add something here that already
exists in the actual codebase.
"""

# Layers, top to bottom in the diagram
LAYERS = ["client", "network", "container", "host", "frontend"]

NODES = {
    "browser":   {"label": "Browser",              "layer": "client"},
    "nginx":     {"label": "nginx",                 "layer": "network"},

    "pihole":    {"label": "Pi-hole",               "layer": "container"},
    "mealie":    {"label": "Mealie",                "layer": "container"},
    "kanboard":  {"label": "Kanboard",              "layer": "container"},

    "trigger":   {"label": "trigger_server.py",     "layer": "host"},
    "mwp":       {"label": "mealie_weekly_plan.py", "layer": "host"},
    "alib":      {"label": "audiobook_lib.py",      "layer": "host"},
    "sysstat":   {"label": "system_status.py",      "layer": "host"},
    "resetmgr":  {"label": "reset_manager.py",      "layer": "host"},
    "updater":   {"label": "updater.py",             "layer": "host"},
    "envcheck":  {"label": "check_env_updates.py",    "layer": "host"},

    "core_js":     {"label": "core.js",             "layer": "frontend"},
    "mealie_js":   {"label": "mealie.js",           "layer": "frontend"},
    "streams_js":  {"label": "streams.js",          "layer": "frontend"},
    "docs_js":     {"label": "docs.js",             "layer": "frontend"},
    "system_js":   {"label": "system.js",           "layer": "frontend"},
    "wizard_js":   {"label": "wizard.js",           "layer": "frontend"},
    "static_js":   {"label": "static-apps.js",      "layer": "frontend"},

    "config_py":   {"label": "config.py",            "layer": "host"},
    "config_js":   {"label": "config.js",             "layer": "frontend"},
    "gendocs":     {"label": "generate_docs_index.py", "layer": "host"},
    "genmap":      {"label": "generate_architecture_map.py", "layer": "host"},
}

# (from, to) -- direction of the real request/data flow
EDGES = [
    ("browser", "nginx"),
    ("nginx", "pihole"),
    ("nginx", "mealie"),
    ("nginx", "kanboard"),
    ("nginx", "trigger"),
    ("trigger", "mwp"),
    ("trigger", "alib"),
    ("trigger", "sysstat"),
    ("trigger", "resetmgr"),
    ("trigger", "updater"),
    ("mwp", "mealie"),
    ("mealie_js", "core_js"),
    ("streams_js", "core_js"),
    ("docs_js", "core_js"),
    ("system_js", "core_js"),
    ("wizard_js", "core_js"),
    ("static_js", "core_js"),
    ("browser", "core_js"),
    ("trigger", "config_py"),
    ("config_js", "core_js"),
]

# Real, on-disk sources the completeness checker cross-references against.
# Maps a NODES key to the actual file/service it must correspond to.
CODE_MAPPING = {
    "pihole": "docker-compose:pihole",
    "mealie": "docker-compose:mealie",
    "kanboard": "docker-compose:kanboard",
    "nginx": "docker-compose:nginx",
    "trigger": "scripts/trigger_server.py",
    "mwp": "scripts/mealie_weekly_plan.py",
    "alib": "audiobooks/audiobook_lib.py",
    "sysstat": "scripts/system_status.py",
    "resetmgr": "scripts/reset_manager.py",
    "updater": "scripts/updater.py",
    "envcheck": "scripts/check_env_updates.py",
    "core_js": "js/core.js",
    "mealie_js": "js/mealie.js",
    "streams_js": "js/streams.js",
    "docs_js": "js/docs.js",
    "system_js": "js/system.js",
    "wizard_js": "js/wizard.js",
    "static_js": "js/static-apps.js",
    "config_py": "scripts/config.py",
    "config_js": "js/config.js",
    "gendocs": "scripts/generate_docs_index.py",
    "genmap": "scripts/generate_architecture_map.py",
}
