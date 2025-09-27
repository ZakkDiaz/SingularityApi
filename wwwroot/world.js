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
        this.attacks = new Map();
        this.timeOfDay = 0;
        this.debugMode = false;
        this.debugInfo = null;

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

    setDebugMode(enabled) {
        this.debugMode = Boolean(enabled);
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

    render(debugInfo = undefined) {
        if (debugInfo !== undefined) {
            this.debugInfo = debugInfo;
        }

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
        this.drawAttacks();
        this.drawPlayers();

        if (this.debugMode) {
            this.drawDebugOverlay();
        }
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

    drawAttacks() {
        const ctx = this.ctx;
        const now = performance.now();
        for (const attack of this.attacks.values()) {
            const screen = this.worldToScreen(attack.x, attack.z);
            const radius = Math.max(attack.radius ?? 1, 0.6) * this.scale;
            const alpha = attack.completed && attack.expireAt
                ? Math.max(0, (attack.expireAt - now) / 200)
                : 1;
            const progress = typeof attack.progress === 'number'
                ? Math.min(1, Math.max(0, attack.progress))
                : 0;

            switch (attack.behavior) {
                case 'projectile': {
                    const color = `rgba(255, 196, 120, ${0.75 * alpha})`;
                    this.drawCircle(screen.x, screen.y, Math.max(6, radius * 0.6), color);
                    if (attack.lastX !== attack.x || attack.lastZ !== attack.z) {
                        const tail = this.worldToScreen(attack.lastX, attack.lastZ);
                        ctx.save();
                        ctx.strokeStyle = `rgba(255, 196, 120, ${0.35 * alpha})`;
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(screen.x, screen.y);
                        ctx.lineTo(tail.x, tail.y);
                        ctx.stroke();
                        ctx.restore();
                    }
                    break;
                }
                case 'sweep': {
                    ctx.save();
                    ctx.strokeStyle = `rgba(126, 206, 255, ${0.4 * alpha})`;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.fillStyle = `rgba(126, 206, 255, ${0.12 * alpha * (1 - progress)})`;
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                    break;
                }
                default: {
                    const ringRadius = Math.max(14, radius * 0.8);
                    ctx.save();
                    ctx.strokeStyle = `rgba(255, 236, 180, ${0.45 * alpha})`;
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, ringRadius, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                    break;
                }
            }
        }
    }

    drawDebugOverlay() {
        if (!this.debugInfo) {
            return;
        }

        const info = this.debugInfo;
        const ctx = this.ctx;
        const localScreen = this.worldToScreen(this.localPlayer.x, this.localPlayer.z);

        if (typeof info.abilityRange === 'number' && info.abilityRange > 0) {
            ctx.save();
            ctx.strokeStyle = 'rgba(126, 255, 209, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.arc(localScreen.x, localScreen.y, info.abilityRange * this.scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        const targetId = info.targetId ?? info.nearestMobId;
        if (!targetId || !this.mobs.has(targetId)) {
            return;
        }

        const mob = this.mobs.get(targetId);
        const targetScreen = this.worldToScreen(mob.x, mob.z);
        const dx = targetScreen.x - localScreen.x;
        const dy = targetScreen.y - localScreen.y;
        const fallbackDistance = Math.hypot(dx, dy) / this.scale;
        const distance = typeof info.targetDistance === 'number'
            ? info.targetDistance
            : (typeof info.nearestDistance === 'number' ? info.nearestDistance : fallbackDistance);
        const inRange = typeof distance === 'number' && typeof info.abilityRange === 'number'
            ? distance <= info.abilityRange + 1e-3
            : false;

        ctx.save();
        ctx.strokeStyle = inRange ? 'rgba(148, 255, 197, 0.9)' : 'rgba(255, 128, 128, 0.9)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(localScreen.x, localScreen.y);
        ctx.lineTo(targetScreen.x, targetScreen.y);
        ctx.stroke();
        ctx.restore();

        if (typeof distance === 'number' && Number.isFinite(distance)) {
            const midX = localScreen.x + dx * 0.5;
            const midY = localScreen.y + dy * 0.5;
            this.drawLabel(`${distance.toFixed(2)}m`, midX, midY - 12, 'rgba(255, 255, 255, 0.95)');
        }

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 232, 140, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(targetScreen.x, targetScreen.y, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
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

    spawnAttack(data) {
        if (!data) {
            return;
        }
        const id = data.attackId ?? data.id;
        if (!id) {
            return;
        }
        const now = performance.now();
        const behavior = (data.behavior ?? 'melee').toLowerCase();
        const originX = data.originX ?? data.origin?.x ?? this.localPlayer.x;
        const originZ = data.originZ ?? data.origin?.z ?? this.localPlayer.z;
        const entry = {
            id,
            abilityId: data.abilityId ?? '',
            ownerId: data.ownerId ?? '',
            behavior,
            x: originX,
            z: originZ,
            lastX: originX,
            lastZ: originZ,
            radius: data.radius ?? 1,
            progress: 0,
            updatedAt: now,
            expireAt: null,
            completed: false,
            directionX: data.directionX ?? data.direction?.x ?? 0,
            directionZ: data.directionZ ?? data.direction?.z ?? 0
        };
        this.attacks.set(id, entry);
    }

    updateAttacks(snapshots = [], completedIds = []) {
        const now = performance.now();

        if (Array.isArray(snapshots)) {
            snapshots.forEach(snapshot => {
                const id = snapshot.attackId ?? snapshot.id;
                if (!id) {
                    return;
                }
                const behavior = snapshot.behavior ? snapshot.behavior.toLowerCase() : null;
                let attack = this.attacks.get(id);
                if (!attack) {
                    attack = {
                        id,
                        abilityId: snapshot.abilityId ?? '',
                        ownerId: snapshot.ownerId ?? '',
                        behavior: behavior ?? 'melee',
                        x: snapshot.x ?? 0,
                        z: snapshot.z ?? 0,
                        lastX: snapshot.x ?? 0,
                        lastZ: snapshot.z ?? 0,
                        radius: snapshot.radius ?? 1,
                        progress: snapshot.progress ?? 0,
                        updatedAt: now,
                        expireAt: null,
                        completed: false,
                        directionX: 0,
                        directionZ: 0
                    };
                    this.attacks.set(id, attack);
                } else {
                    attack.lastX = attack.x;
                    attack.lastZ = attack.z;
                    attack.x = snapshot.x ?? attack.x;
                    attack.z = snapshot.z ?? attack.z;
                    attack.updatedAt = now;
                    if (typeof snapshot.radius === 'number') {
                        attack.radius = snapshot.radius;
                    }
                    if (typeof snapshot.progress === 'number') {
                        attack.progress = snapshot.progress;
                    }
                    if (behavior) {
                        attack.behavior = behavior;
                    }
                }
            });
        }

        if (Array.isArray(completedIds)) {
            completedIds.forEach(id => {
                const attack = this.attacks.get(id);
                if (attack) {
                    attack.completed = true;
                    attack.expireAt = now + 180;
                }
            });
        }

        for (const [id, attack] of this.attacks) {
            if (attack.completed && attack.expireAt && attack.expireAt < now) {
                this.attacks.delete(id);
                continue;
            }
            if (!attack.completed && now - attack.updatedAt > 800) {
                this.attacks.delete(id);
            }
        }
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
