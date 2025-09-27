// world.js

const DEFAULT_SCALE = 14; // pixels per world unit
const GRID_SPACING = 6;
const GRID_COLOR = 'rgba(255, 255, 255, 0.05)';

export class World {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.canvas.id = 'gameCanvas';
            document.body.appendChild(this.canvas);
        }
        this.ctx = this.canvas.getContext('2d');
        this.scale = DEFAULT_SCALE;
        this.localPlayerId = null;
        this.localPlayer = { x: 0, z: 0, heading: 0 };
        this.remotePlayers = new Map();
        this.mobs = new Map();
        this.highlightedMobId = null;
        this.mobFlashTimers = new Map();
        this.timeOfDay = 0;

        window.addEventListener('resize', () => this.handleResize());
        this.handleResize();
    }

    handleResize() {
        if (!this.canvas) {
            return;
        }
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    updateLocalPlayer(x, z, heading = 0) {
        this.localPlayer = { x, z, heading };
    }

    upsertRemotePlayer(snapshot) {
        if (!snapshot || !snapshot.playerId) {
            return;
        }
        if (snapshot.playerId === this.localPlayerId) {
            this.updateLocalPlayer(snapshot.x ?? 0, snapshot.z ?? 0, snapshot.heading ?? 0);
            return;
        }
        this.remotePlayers.set(snapshot.playerId, {
            id: snapshot.playerId,
            name: snapshot.displayName ?? snapshot.playerId,
            x: snapshot.x ?? 0,
            z: snapshot.z ?? 0,
            heading: snapshot.heading ?? 0
        });
    }

    removeRemotePlayer(playerId) {
        this.remotePlayers.delete(playerId);
    }

    ingestChunks(chunks = []) {
        const seenMobIds = new Set();
        chunks.forEach(chunk => {
            (chunk.mobs ?? []).forEach(mob => {
                this.updateMob(mob);
                seenMobIds.add(mob.id);
            });
        });

        // Remove mobs that were not present in the latest payload
        if (seenMobIds.size > 0) {
            for (const mobId of this.mobs.keys()) {
                if (!seenMobIds.has(mobId)) {
                    this.mobs.delete(mobId);
                    this.mobFlashTimers.delete(mobId);
                }
            }
        }
    }

    updateMob(mob) {
        if (!mob || !mob.id) {
            return;
        }
        this.mobs.set(mob.id, {
            id: mob.id,
            name: mob.name ?? 'Enemy',
            x: mob.x ?? 0,
            z: mob.z ?? 0,
            isAlive: mob.isAlive !== false,
            healthFraction: typeof mob.healthFraction === 'number' ? mob.healthFraction : 1,
            targetPlayerId: mob.targetPlayerId ?? null
        });
    }

    applyMobUpdate(mobs) {
        if (!Array.isArray(mobs)) {
            return;
        }
        mobs.forEach(mob => this.updateMob(mob));
    }

    playMobAttack(mobId) {
        if (!mobId) {
            return;
        }
        const until = performance.now() + 250;
        this.mobFlashTimers.set(mobId, until);
    }

    setHighlightedMob(mobId) {
        this.highlightedMobId = mobId || null;
    }

    updateWorldTime(timeOfDayFraction) {
        this.timeOfDay = timeOfDayFraction;
    }

    findNearestMob(position, maxDistance = Infinity) {
        let best = null;
        let bestDistance = maxDistance;
        for (const mob of this.mobs.values()) {
            if (!mob.isAlive) {
                continue;
            }
            const dx = mob.x - position.x;
            const dz = mob.z - position.z;
            const distance = Math.hypot(dx, dz);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { ...mob, distance };
            }
        }
        return best;
    }

    render() {
        if (!this.ctx || !this.canvas) {
            return;
        }
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        ctx.clearRect(0, 0, width, height);

        ctx.fillStyle = '#0f1118';
        ctx.fillRect(0, 0, width, height);

        this.drawGrid();
        this.drawMobs();
        this.drawPlayers();
    }

    drawGrid() {
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        const centerX = width / 2;
        const centerY = height / 2;
        const spacing = GRID_SPACING * this.scale;

        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();

        const offsetX = (this.localPlayer.x % GRID_SPACING) * this.scale;
        const offsetZ = (this.localPlayer.z % GRID_SPACING) * this.scale;

        for (let x = centerX - offsetX; x < width; x += spacing) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        for (let x = centerX - offsetX; x > 0; x -= spacing) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }

        for (let y = centerY - offsetZ; y < height; y += spacing) {
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
        }
        for (let y = centerY - offsetZ; y > 0; y -= spacing) {
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
        }

        ctx.stroke();
    }

    drawPlayers() {
        const ctx = this.ctx;
        const now = performance.now();
        for (const player of this.remotePlayers.values()) {
            const { x, y } = this.worldToScreen(player.x, player.z);
            this.drawCircle(x, y, 12, 'rgba(70, 149, 255, 0.7)');
            this.drawHeading(x, y, player.heading, 'rgba(255, 255, 255, 0.35)');
            this.drawLabel(player.name, x, y - 22, 'rgba(255, 255, 255, 0.7)');
        }

        const local = this.localPlayer;
        const localScreen = this.worldToScreen(local.x, local.z);
        this.drawCircle(localScreen.x, localScreen.y, 14, '#4bffa5');
        this.drawHeading(localScreen.x, localScreen.y, local.heading, '#0b0f18');
        this.drawLabel('You', localScreen.x, localScreen.y - 24, '#e5f7ff');

        if (this.highlightedMobId && this.mobs.has(this.highlightedMobId)) {
            const mob = this.mobs.get(this.highlightedMobId);
            const { x, y } = this.worldToScreen(mob.x, mob.z);
            const pulse = 1 + Math.sin(now / 120) * 0.1;
            this.drawRing(x, y, 22 * pulse, '#f8c550');
        }
    }

    drawMobs() {
        const ctx = this.ctx;
        const now = performance.now();
        for (const mob of this.mobs.values()) {
            const { x, y } = this.worldToScreen(mob.x, mob.z);
            const baseColor = mob.isAlive ? '#f26c6c' : 'rgba(120, 120, 120, 0.6)';
            this.drawCircle(x, y, 12, baseColor);

            const healthWidth = Math.max(0, Math.min(1, mob.healthFraction)) * 24;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(x - 12, y + 16, 24, 4);
            ctx.fillStyle = '#ff9e9e';
            ctx.fillRect(x - 12, y + 16, healthWidth, 4);

            if (this.mobFlashTimers.has(mob.id)) {
                const until = this.mobFlashTimers.get(mob.id);
                if (until && until > now) {
                    this.drawRing(x, y, 20, 'rgba(255, 255, 255, 0.7)');
                } else {
                    this.mobFlashTimers.delete(mob.id);
                }
            }

            this.drawLabel(mob.name, x, y - 20, 'rgba(255, 230, 230, 0.75)');
        }
    }

    drawCircle(x, y, radius, color) {
        const ctx = this.ctx;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    drawRing(x, y, radius, color) {
        const ctx = this.ctx;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
    }

    drawHeading(x, y, heading, color) {
        const ctx = this.ctx;
        const length = 18;
        const dx = Math.sin(heading) * length;
        const dz = Math.cos(heading) * length;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx, y - dz);
        ctx.stroke();
    }

    drawLabel(text, x, y, color) {
        const ctx = this.ctx;
        ctx.font = '12px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(text, x, y);
    }

    worldToScreen(x, z) {
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        const dx = (x - this.localPlayer.x) * this.scale;
        const dz = (z - this.localPlayer.z) * this.scale;
        return {
            x: centerX + dx,
            y: centerY + dz
        };
    }
}
