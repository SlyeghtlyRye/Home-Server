"""
generate_architecture_map.py -- renders docs/architecture-map.py's data
into a static SVG diagram, and cross-checks it against the real codebase
so a developer can't silently forget to add a new component.

Run manually after editing docs/architecture-map.py:
    python3 scripts/generate_architecture_map.py
"""
import importlib.util
import os
import re

ROOT = "/root"
MAP_DATA_PATH = os.path.join(ROOT, "docs", "architecture-map.py")
SVG_OUTPUT_PATH = os.path.join(ROOT, "docs", "architecture-map.svg")

LAYER_COLORS = {
    "client": "#2f4a63",
    "network": "#3a2f1a",
    "container": "#233b2d",
    "host": "#2d2d2d",
    "frontend": "#2f2d4a",
}
LAYER_LABELS = {
    "client": "Client",
    "network": "Network / Proxy",
    "container": "Docker Containers",
    "host": "Host Scripts (non-Docker)",
    "frontend": "Frontend Modules (js/)",
}


def load_map_data():
    spec = importlib.util.spec_from_file_location("architecture_map", MAP_DATA_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def render_svg(am):
    node_width, node_height = 170, 40
    col_gap, row_gap = 30, 90
    margin = 40

    by_layer = {layer: [] for layer in am.LAYERS}
    for key, node in am.NODES.items():
        by_layer[node["layer"]].append(key)

    positions = {}
    max_row_count = max(len(nodes) for nodes in by_layer.values())
    svg_width = margin * 2 + max_row_count * (node_width + col_gap)
    svg_height = margin * 2 + len(am.LAYERS) * (node_height + row_gap)

    for row_idx, layer in enumerate(am.LAYERS):
        nodes = by_layer[layer]
        y = margin + row_idx * (node_height + row_gap)
        row_width = len(nodes) * (node_width + col_gap) - col_gap
        start_x = (svg_width - row_width) / 2
        for col_idx, key in enumerate(nodes):
            x = start_x + col_idx * (node_width + col_gap)
            positions[key] = (x, y)

    def center(key):
        x, y = positions[key]
        return x + node_width / 2, y + node_height / 2

    parts = [f'<svg viewBox="0 0 {svg_width} {svg_height}" xmlns="http://www.w3.org/2000/svg" font-family="Arial, sans-serif">']
    parts.append('<rect width="100%" height="100%" fill="#1a1a1a"/>')
    parts.append('<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#666"/></marker></defs>')

    # Edges drawn first so nodes render on top of their own endpoints.
    # Each edge carries data-src/data-dst plus current center coordinates
    # so the drag script (in docs.js) can find and update it live.
    for src, dst in am.EDGES:
        if src not in positions or dst not in positions:
            continue
        x1, y1 = positions[src]
        x2, y2 = positions[dst]
        scx, scy = center(src)
        dcx, dcy = center(dst)

        if y1 == y2:
            mid_x = (scx + dcx) / 2
            arc_y = scy + node_height / 2 + 22
            parts.append(
                f'<path data-src="{src}" data-dst="{dst}" '
                f'data-src-cx="{scx}" data-src-cy="{scy}" data-dst-cx="{dcx}" data-dst-cy="{dcy}" '
                f'd="M {scx},{scy} Q {mid_x},{arc_y} {dcx},{dcy}" fill="none" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>'
            )
        else:
            parts.append(
                f'<line data-src="{src}" data-dst="{dst}" '
                f'data-src-cx="{scx}" data-src-cy="{scy}" data-dst-cx="{dcx}" data-dst-cy="{dcy}" '
                f'x1="{scx}" y1="{scy}" x2="{dcx}" y2="{dcy}" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>'
            )

    for row_idx, layer in enumerate(am.LAYERS):
        y = margin + row_idx * (node_height + row_gap) - 20
        parts.append(f'<text x="{margin}" y="{y}" fill="#888" font-size="12">{LAYER_LABELS[layer]}</text>')

    # Each node is a <g> wrapped around its own rect+text, translated as a
    # unit -- data-node-id on the rect is how the drag script finds it,
    # and the group's own transform is what actually moves on drag.
    for key, node in am.NODES.items():
        x, y = positions[key]
        color = LAYER_COLORS[node["layer"]]
        parts.append(f'<g class="node-group" data-node-id="{key}" transform="translate({x}, {y})" data-x-y="{x},{y}">')
        parts.append(f'<rect data-node-id="{key}" x="0" y="0" width="{node_width}" height="{node_height}" rx="6" fill="{color}" stroke="#555"/>')
        parts.append(f'<text x="{node_width/2}" y="{node_height/2 + 5}" fill="white" font-size="12" text-anchor="middle" style="pointer-events:none;">{node["label"]}</text>')
        parts.append('</g>')

    parts.append('</svg>')
    return '\n'.join(parts)


def get_real_compose_services():
    compose_path = os.path.join(ROOT, "docker-compose.yml")
    services = []
    with open(compose_path) as f:
        in_services = False
        for line in f:
            if line.strip() == "services:":
                in_services = True
                continue
            if in_services:
                m = re.match(r"^  (\w[\w-]*):$", line)
                if m:
                    services.append(m.group(1))
                elif line.strip() and not line.startswith("  ") and not line.startswith("    "):
                    break
    return services


def get_real_js_files():
    js_dir = os.path.join(ROOT, "js")
    return [f for f in os.listdir(js_dir) if f.endswith(".js")]


def get_real_script_files():
    scripts_dir = os.path.join(ROOT, "scripts")
    return [f for f in os.listdir(scripts_dir) if f.endswith(".py")]


def check_completeness(am):
    mapped_targets = set(am.CODE_MAPPING.values())
    missing = []

    for service in get_real_compose_services():
        target = f"docker-compose:{service}"
        if target not in mapped_targets:
            missing.append(target)

    for js_file in get_real_js_files():
        target = f"js/{js_file}"
        if target not in mapped_targets:
            missing.append(target)

    for script_file in get_real_script_files():
        target = f"scripts/{script_file}"
        if target not in mapped_targets:
            missing.append(target)

    audiobook_lib_target = "audiobooks/audiobook_lib.py"
    if os.path.exists(os.path.join(ROOT, audiobook_lib_target)) and audiobook_lib_target not in mapped_targets:
        missing.append(audiobook_lib_target)

    return missing


if __name__ == "__main__":
    am = load_map_data()
    svg = render_svg(am)
    with open(SVG_OUTPUT_PATH, "w") as f:
        f.write(svg)
    print(f"Wrote {SVG_OUTPUT_PATH} ({len(am.NODES)} nodes, {len(am.EDGES)} edges)")

    missing = check_completeness(am)
    if missing:
        print(f"WARNING: {len(missing)} real component(s) not represented in architecture-map.py:")
        for m in missing:
            print(f"  - {m}")
    else:
        print("Architecture map is complete -- every real component is represented.")
