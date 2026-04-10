# OrbStack Management Guide — Riverside OS

This guide covers the transition from Docker Desktop to [OrbStack](https://orbstack.dev/) for Riverside OS development. OrbStack is the recommended Docker engine for macOS due to its significantly better performance (VirtioFS), lower resource footprint, and native Apple Silicon optimization.

## 1. Locking in the Switch
To ensure your terminal and applications point exclusively to OrbStack even if Docker Desktop is still installed:

### The Context Switch
Docker uses **Contexts** to determine which daemon the CLI communicates with.

```bash
# See current state
docker context ls

# Force use of OrbStack
docker context use orbstack
```

Verify that the asterisk `*` is next to `orbstack`. This updates `~/.docker/config.json`.

### Verifying the Socket
Most tools (including the ROS bridge) look for the engine at `/var/run/docker.sock`.

```bash
ls -l /var/run/docker.sock
```
It should point to a path containing `.orbstack`, e.g., `/Users/yourname/.orbstack/run/docker.sock`.

If it still points to Docker Desktop, run:
```bash
orb setup
```
Select **Link Docker socket** when prompted.

## 2. Validation (The "Acid Test")
To confirm your active session is definitely running on OrbStack:

```bash
docker info | grep "Name: orbstack"
```

Also, ensure `DOCKER_HOST` is **not** set in your shell environment, as it can bypass context settings:
```bash
echo $DOCKER_HOST
# Result should be empty
```

## 3. Fresh Migration (Pull & Build)
When switching engines, it is best practice to treat it as a fresh install rather than copying potentially corrupted layers from Docker Desktop.

1. Navigate to the project root.
2. Rebuild from scratch:
   ```bash
   docker-compose up -d --build
   ```
3. Initialize the database (fresh volumes will be created):
   ```bash
   ./scripts/apply-migrations-docker.sh
   ```

## 4. Performance Benefits for ROS
- **VirtioFS**: File syncing between your Mac and containers (like `riverside_pgdata`) is significantly faster, reducing latency in the POS and CRM.
- **M3 Pro Optimization**: Native support for Apple Silicon instructions.
- **Network Efficiency**: Faster container startup and image pulls.

## 5. Cleaning Up
Once you are confident in the switch:
- Quit Docker Desktop.
- Disable "Start Docker Desktop when you log in".
- You do not need to uninstall Docker Desktop, but keeping it off ensures no interference with the `/var/run/docker.sock` link.
