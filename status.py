#!/usr/bin/env python3
import subprocess
import json

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
    except:
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
    except:
        pass
    return stats

# Container metadata
container_info = {
    'pihole': {
        'description': 'DNS ad-blocker & network-wide blocking',
        'image': 'pihole/pihole',
        'link': 'http://home.pihole/admin'
    },
    'nginx': {
        'description': 'Reverse proxy & dashboard router',
        'image': 'nginx:alpine',
        'link': 'http://home.dashboard'
    },
    'mealie': {
        'description': 'Meal planning & auto-generated grocery lists',
        'image': 'ghcr.io/mealie-recipes/mealie',
        'link': 'http://home.meals'
    },
    'kanboard': {
        'description': 'Chores & task management board',
        'image': 'kanboard/kanboard',
        'link': 'http://home.chores'
    }
}

# System info
uptime = run("uptime | awk -F'up' '{print $2}' | awk -F',' '{print $1}'").strip()
memory = run("free -h | grep Mem | awk '{print $3 \"/\" $2}'")
disk = run("df -h / | tail -1 | awk '{print $3 \"/\" $2}'")
cpu_temp = run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{print $1/1000}' || echo 'N/A'")

print("\n" + "="*70)
print("  🏠 HOME MANAGEMENT SYSTEM - STATUS REPORT")
print("="*70)
print(f"\n  ⏱️  Uptime:     {uptime}")
print(f"  🧠 Memory:     {memory}")
print(f"  💾 Disk:       {disk}")
print(f"  🌡️  CPU Temp:   {cpu_temp}°C")

# Container details
containers = get_container_info()
stats = get_container_stats()

print(f"\n{'='*70}")
print("  📦 CONTAINERS")
print(f"{'='*70}\n")

for name, info in containers.items():
    status = info['Status']
    stat = stats.get(name, {})
    meta = container_info.get(name, {})
    
    # Health indicator
    if 'healthy' in status.lower():
        health = "✅"
    elif 'unhealthy' in status.lower():
        health = "⚠️"
    else:
        health = "✅"  # Changed from ⏳ to ✅
    
    print(f"  {health} {name.upper()}")
    print(f"     {meta.get('description', 'N/A')}")
    print(f"     Image:   {meta.get('image', 'N/A')}")
    print(f"     Status:  {status}")
    if stat:
        cpu = stat.get('CPUPerc', 'N/A').replace('%', '')
        mem = stat.get('MemUsage', 'N/A')
        print(f"     CPU:     {cpu}%")
        print(f"     Memory:  {mem}")
    print(f"     Link:    {meta.get('link', 'N/A')}")
    print()

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

SYSTEMD_SERVICES = ["mealie-trigger", "icecast2", "tailscaled"]

print(f"{'='*70}")
print("  🧩 HOST SERVICES (non-Docker)")
print(f"{'='*70}\n")

for svc in SYSTEMD_SERVICES:
    active, enabled = get_systemd_status(svc)
    health = "✅" if active == "active" else "⚠️"
    print(f"  {health} {svc}")
    print(f"     Active:   {active}")
    print(f"     Enabled:  {enabled}")
    print()

print("="*70)
print("  Dashboard: http://home.dashboard")
print("="*70 + "\n")
