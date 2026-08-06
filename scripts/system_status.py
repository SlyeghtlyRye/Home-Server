"""
system_status.py -- shared system/container status logic.
Used by both status.py (CLI report) and trigger_server.py's
/data/system-status endpoint, so there's one source of truth.
"""
import subprocess
import json

CONTAINER_INFO = {
    'pihole': {
        'description': 'DNS ad-blocker & network-wide blocking',
        'image': 'pihole/pihole',
        'link': 'http://home.pihole',
    },
    'nginx': {
        'description': 'Reverse proxy & dashboard router',
        'image': 'nginx:alpine',
        'link': 'http://home.dashboard',
    },
    'mealie': {
        'description': 'Meal planning & auto-generated grocery lists',
        'image': 'ghcr.io/mealie-recipes/mealie',
        'link': 'http://home.meals',
    },
    'kanboard': {
        'description': 'Chores & task management board',
        'image': 'kanboard/kanboard',
        'link': 'http://home.chores',
    },
}

SYSTEMD_SERVICES = ["mealie-trigger", "icecast2", "tailscaled"]


def run(cmd):
    return subprocess.check_output(cmd, shell=True, text=True).strip()


def get_container_info():
    containers = {}
    try:
        output = run("docker ps --format json")
        for line in output.split('\n'):
            if line:
                data = json.loads(line)
                containers[data['Names']] = data
    except Exception:
        pass
    return containers


def get_container_stats():
    stats = {}
    try:
        output = run("docker stats --no-stream --format json")
        for line in output.split('\n'):
            if line:
                data = json.loads(line)
                stats[data['Name']] = data
    except Exception:
        pass
    return stats


def get_systemd_status(service):
    try:
        active = run(f"systemctl is-active {service}")
    except subprocess.CalledProcessError as e:
        active = e.output.strip() if e.output else "unknown"
    try:
        enabled = run(f"systemctl is-enabled {service}")
    except subprocess.CalledProcessError as e:
        enabled = e.output.strip() if e.output else "unknown"
    return active, enabled


def collect_status():
    """Returns a plain dict, safe to json.dumps directly."""
    uptime = run("uptime | awk -F'up' '{print $2}' | awk -F',' '{print $1}'").strip()
    memory = run("free -h | grep Mem | awk '{print $3 \"/\" $2}'")
    disk = run("df -h / | tail -1 | awk '{print $3 \"/\" $2}'")
    try:
        cpu_temp = run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{print $1/1000}'")
    except Exception:
        cpu_temp = None

    raw_containers = get_container_info()
    stats = get_container_stats()

    containers = []
    for name, info in raw_containers.items():
        status = info['Status']
        stat = stats.get(name, {})
        meta = CONTAINER_INFO.get(name, {})
        healthy = 'unhealthy' not in status.lower()
        containers.append({
            'name': name,
            'status': status,
            'healthy': healthy,
            'description': meta.get('description'),
            'image': meta.get('image'),
            'link': meta.get('link'),
            'cpu_percent': stat.get('CPUPerc', '').replace('%', '') if stat else None,
            'memory_usage': stat.get('MemUsage') if stat else None,
        })

    host_services = []
    for svc in SYSTEMD_SERVICES:
        active, enabled = get_systemd_status(svc)
        host_services.append({
            'name': svc,
            'active': active,
            'enabled': enabled,
            'healthy': active == 'active',
        })

    return {
        'uptime': uptime,
        'memory': memory,
        'disk': disk,
        'cpu_temp': cpu_temp,
        'containers': containers,
        'host_services': host_services,
    }
