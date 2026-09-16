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


def restart_service(name):
    """Deliberately scoped to exactly the three names in SYSTEMD_SERVICES
    -- never accepts an arbitrary string from a request, so this can't
    become a general command-execution surface no matter what a caller
    passes in.

    mealie-trigger is the process serving THIS very request, so
    restarting it synchronously would drop the connection mid-restart --
    the same self-referential problem updater.py's
    _schedule_background_restart() already exists to avoid for software
    updates. Only that one name needs the detached-background treatment;
    icecast2/tailscaled restart normally, since neither is the process
    handling the request."""
    if name not in SYSTEMD_SERVICES:
        raise ValueError(f"not a recognized host service: {name!r}")
    if name == "mealie-trigger":
        subprocess.Popen(
            ["setsid", "bash", "-c", "sleep 2 && systemctl restart mealie-trigger.service"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    else:
        subprocess.run(["systemctl", "restart", name], check=True, timeout=15)


def get_service_logs(name, lines=50):
    """Same fixed allow-list as restart_service() -- `name` never reaches
    a shell here (list-form subprocess.run, no shell=True), so even if
    validation were somehow bypassed there's no shell-injection surface."""
    if name not in SYSTEMD_SERVICES:
        raise ValueError(f"not a recognized host service: {name!r}")
    result = subprocess.run(
        ["journalctl", "-u", name, "-n", str(lines), "--no-pager"],
        capture_output=True, text=True, timeout=15,
    )
    return [line for line in result.stdout.strip("\n").split("\n") if line]


def collect_basics():
    """Uptime/memory/disk/temp -- a handful of near-instant reads, split
    out from collect_containers()/collect_services() specifically so the
    dashboard can show this immediately without waiting on `docker stats`
    (which samples CPU over an interval and commonly takes 1-2+ seconds)
    or several sequential `systemctl` calls."""
    uptime = run("uptime | awk -F'up' '{print $2}' | awk -F',' '{print $1}'").strip()
    memory = run("free -h | grep Mem | awk '{print $3 \"/\" $2}'")
    disk = run("df -h / | tail -1 | awk '{print $3 \"/\" $2}'")
    try:
        cpu_temp = run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{print $1/1000}'")
    except Exception:
        cpu_temp = None
    return {'uptime': uptime, 'memory': memory, 'disk': disk, 'cpu_temp': cpu_temp}


def collect_containers():
    """The slow one -- `docker stats --no-stream` has to sample CPU usage
    over a brief interval rather than just reading a cached value."""
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
    return {'containers': containers}


def collect_services():
    """Three systemd services, two `systemctl` calls each -- moderate,
    but still no reason to make collect_basics() wait on it."""
    host_services = []
    for svc in SYSTEMD_SERVICES:
        active, enabled = get_systemd_status(svc)
        host_services.append({
            'name': svc,
            'active': active,
            'enabled': enabled,
            'healthy': active == 'active',
        })
    return {'host_services': host_services}


def collect_status():
    """Full combined report, for a caller that wants everything in one
    call (e.g. a future CLI use) rather than the three split ones the
    dashboard itself uses to render each card as its own data arrives."""
    result = {}
    result.update(collect_basics())
    result.update(collect_containers())
    result.update(collect_services())
    return result
