const DOWN_AXIS = new THREE.Vector3(0, -1, 0);
const FORWARD_AXIS = new THREE.Vector3(0, 0, -1);
const SIDE_AXIS = new THREE.Vector3(1, 0, 0);

const _aimDir = new THREE.Vector3();
const _aimOrigin = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _shoulderPos = new THREE.Vector3();
const _elbowPos = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _planeRight = new THREE.Vector3();
const _planeUp = new THREE.Vector3();
const _upperDir = new THREE.Vector3();
const _lowerDir = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _parentQuatInv = new THREE.Quaternion();
const _shoulderWorldQuat = new THREE.Quaternion();
const _elbowWorldQuat = new THREE.Quaternion();
const _localShoulderQuat = new THREE.Quaternion();
const _localElbowQuat = new THREE.Quaternion();
const _tmpQuat = new THREE.Quaternion();
const _tmpQuat2 = new THREE.Quaternion();
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpVec3 = new THREE.Vector3();
const _ikEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function buildHumanoid(options = {}) {
    const {
        bodyColor = 0x3f6fb5,
        accentColor = 0xe3efff,
        trimColor = 0x89b7ff,
        weaponColor = 0xffffff,
        weaponHandleColor = 0x2c2f3a,
        height = 1.8,
        decorate
    } = options;

    const group = new THREE.Group();

    const torsoHeight = height * 0.48;
    const hipHeight = height * 0.26;
    const shoulderHeight = torsoHeight + 0.38;
    const armLength = height * 0.42;
    const legLength = height * 0.48;
    const upperArmLength = armLength * 0.55;
    const lowerArmLength = armLength * 0.45;
    const upperLegLength = legLength * 0.58;
    const lowerLegLength = legLength * 0.42;

    const torso = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.34, torsoHeight * 0.6, 10, 18),
        new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.2, roughness: 0.45 })
    );
    torso.position.y = torsoHeight;
    group.add(torso);

    const trim = new THREE.Mesh(
        new THREE.TorusGeometry(0.45, 0.05, 12, 32),
        new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.65, roughness: 0.25 })
    );
    trim.position.y = torso.position.y + 0.05;
    trim.rotation.x = Math.PI / 2;
    group.add(trim);

    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 24, 18),
        new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.1, roughness: 0.35 })
    );
    head.position.y = height * 0.92;
    group.add(head);

    const leftShoulder = new THREE.Group();
    leftShoulder.position.set(0.42, shoulderHeight, 0);
    group.add(leftShoulder);

    const leftArmUpper = new THREE.Group();
    leftShoulder.add(leftArmUpper);
    const leftArmUpperMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.12, upperArmLength * 0.5, 8, 16),
        new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.3, roughness: 0.4 })
    );
    leftArmUpperMesh.position.y = -upperArmLength * 0.5;
    leftArmUpper.add(leftArmUpperMesh);

    const leftElbow = new THREE.Group();
    leftElbow.position.y = -upperArmLength;
    leftArmUpper.add(leftElbow);

    const leftArmLowerMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.11, lowerArmLength * 0.45, 8, 16),
        new THREE.MeshStandardMaterial({ color: trimColor, metalness: 0.2, roughness: 0.45 })
    );
    leftArmLowerMesh.position.y = -lowerArmLength * 0.5;
    leftElbow.add(leftArmLowerMesh);

    const leftHand = new THREE.Group();
    leftHand.position.y = -lowerArmLength;
    leftElbow.add(leftHand);

    const rightShoulder = new THREE.Group();
    rightShoulder.position.set(-0.42, shoulderHeight, 0);
    group.add(rightShoulder);

    const rightArmUpper = new THREE.Group();
    rightShoulder.add(rightArmUpper);
    const rightArmUpperMesh = leftArmUpperMesh.clone();
    rightArmUpperMesh.material = leftArmUpperMesh.material.clone();
    rightArmUpper.add(rightArmUpperMesh);

    const rightElbow = new THREE.Group();
    rightElbow.position.y = -upperArmLength;
    rightArmUpper.add(rightElbow);

    const rightArmLowerMesh = leftArmLowerMesh.clone();
    rightArmLowerMesh.material = leftArmLowerMesh.material.clone();
    rightArmLowerMesh.position.y = -lowerArmLength * 0.5;
    rightElbow.add(rightArmLowerMesh);

    const rightHand = new THREE.Group();
    rightHand.position.y = -lowerArmLength;
    rightElbow.add(rightHand);

    const weaponPivot = new THREE.Group();
    weaponPivot.position.set(0, -0.18, 0.12);
    const weaponHandle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.6, 10),
        new THREE.MeshStandardMaterial({ color: weaponHandleColor, roughness: 0.45 })
    );
    weaponHandle.rotation.z = Math.PI / 2;
    weaponHandle.position.y = -0.18;
    weaponPivot.add(weaponHandle);

    const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 1.2, 0.18),
        new THREE.MeshStandardMaterial({
            color: weaponColor,
            emissive: new THREE.Color(weaponColor).multiplyScalar(0.18),
            metalness: 0.5,
            roughness: 0.25
        })
    );
    blade.position.y = -0.78;
    weaponPivot.add(blade);
    weaponPivot.rotation.set(-0.6, 0, 0);
    rightHand.add(weaponPivot);

    const leftHip = new THREE.Group();
    leftHip.position.set(0.26, hipHeight, 0);
    group.add(leftHip);

    const leftLegUpper = new THREE.Group();
    leftHip.add(leftLegUpper);
    const leftLegUpperMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.16, upperLegLength * 0.5, 10, 16),
        new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.18, roughness: 0.55 })
    );
    leftLegUpperMesh.position.y = -upperLegLength * 0.5;
    leftLegUpper.add(leftLegUpperMesh);

    const leftKnee = new THREE.Group();
    leftKnee.position.y = -upperLegLength;
    leftLegUpper.add(leftKnee);

    const leftLegLowerMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.13, lowerLegLength * 0.45, 10, 16),
        new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.12, roughness: 0.55 })
    );
    leftLegLowerMesh.position.y = -lowerLegLength * 0.5;
    leftKnee.add(leftLegLowerMesh);

    const leftFoot = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, 0.14, 0.5),
        new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.1, roughness: 0.6 })
    );
    leftFoot.position.set(0, -lowerLegLength, 0.12);
    leftKnee.add(leftFoot);

    const rightHip = new THREE.Group();
    rightHip.position.set(-0.26, hipHeight, 0);
    group.add(rightHip);

    const rightLegUpper = new THREE.Group();
    rightHip.add(rightLegUpper);
    const rightLegUpperMesh = leftLegUpperMesh.clone();
    rightLegUpperMesh.material = leftLegUpperMesh.material.clone();
    rightLegUpper.add(rightLegUpperMesh);

    const rightKnee = new THREE.Group();
    rightKnee.position.y = -upperLegLength;
    rightLegUpper.add(rightKnee);

    const rightLegLowerMesh = leftLegLowerMesh.clone();
    rightLegLowerMesh.material = leftLegLowerMesh.material.clone();
    rightLegLowerMesh.position.y = -lowerLegLength * 0.5;
    rightKnee.add(rightLegLowerMesh);

    const rightFoot = leftFoot.clone();
    rightFoot.material = leftFoot.material.clone();
    rightFoot.position.set(0, -lowerLegLength, 0.12);
    rightKnee.add(rightFoot);

    group.traverse(node => {
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });

    const humanoidData = {
        parts: {
            torso,
            head,
            trim,
            leftShoulder,
            rightShoulder,
            leftArmUpper,
            leftArmLower: leftElbow,
            leftHand,
            rightArmUpper,
            rightArmLower: rightElbow,
            rightHand,
            leftLegUpper,
            leftLegLower: leftKnee,
            leftFoot,
            rightLegUpper,
            rightLegLower: rightKnee,
            rightFoot,
            weaponPivot,
            weapon: blade,
            weaponHandle
        },
        state: {
            movePhase: Math.random() * Math.PI * 2,
            attackTimer: 0,
            aimDirectionWorld: new THREE.Vector3(0, 0, -1),
            aimBlend: 0
        },
        dimensions: {
            upperArmLength,
            lowerArmLength,
            upperLegLength,
            lowerLegLength
        }
    };

    group.userData.humanoid = humanoidData;

    if (typeof decorate === 'function') {
        decorate(group, humanoidData);
    }

    return group;
}

export function createPlayerAvatar(overrides = {}) {
    return buildHumanoid({
        bodyColor: overrides.bodyColor ?? 0x2c5fa8,
        accentColor: overrides.accentColor ?? 0xf0f5ff,
        trimColor: overrides.trimColor ?? 0x77bbff,
        weaponColor: overrides.weaponColor ?? 0xe3f1ff,
        weaponHandleColor: overrides.weaponHandleColor ?? 0x1c2330,
        height: overrides.height ?? 1.82,
        decorate(group, data) {
            if (!data?.parts?.head) {
                return;
            }
            const crest = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.18, 0.08),
                new THREE.MeshStandardMaterial({ color: overrides.crestColor ?? 0xffffff, metalness: 0.55, roughness: 0.3 })
            );
            crest.position.set(0, data.parts.head.position.y + 0.18, 0);
            group.add(crest);
        }
    });
}

export function createMobAvatar(overrides = {}) {
    const mob = buildHumanoid({
        bodyColor: overrides.bodyColor ?? 0x3b1d29,
        accentColor: overrides.accentColor ?? 0xfdd1a3,
        trimColor: overrides.trimColor ?? 0xff7b4a,
        weaponColor: overrides.weaponColor ?? 0xffc05a,
        weaponHandleColor: overrides.weaponHandleColor ?? 0x3a241b,
        height: overrides.height ?? 1.9,
        decorate(group, data) {
            if (!data?.parts?.head) {
                return;
            }
            const hornMaterial = new THREE.MeshStandardMaterial({ color: 0xffa86b, metalness: 0.3, roughness: 0.4 });
            const hornGeometry = new THREE.ConeGeometry(0.12, 0.4, 12);
            const leftHorn = new THREE.Mesh(hornGeometry, hornMaterial);
            leftHorn.position.set(0.18, data.parts.head.position.y + 0.15, 0.12);
            leftHorn.rotation.set(Math.PI / 2.4, 0, -Math.PI / 6);
            const rightHorn = leftHorn.clone();
            rightHorn.position.x *= -1;
            rightHorn.rotation.z *= -1;
            group.add(leftHorn);
            group.add(rightHorn);

            const leftShoulder = data.parts.leftShoulder;
            const rightShoulder = data.parts.rightShoulder;
            if (!leftShoulder || !rightShoulder) {
                return;
            }
            const pauldronGeometry = new THREE.ConeGeometry(0.45, 0.5, 16, 1, true);
            const pauldronMaterial = new THREE.MeshStandardMaterial({
                color: overrides.pauldronColor ?? 0x8e2f3a,
                metalness: 0.4,
                roughness: 0.35,
                side: THREE.DoubleSide
            });
            const leftPauldrons = new THREE.Mesh(pauldronGeometry, pauldronMaterial);
            leftPauldrons.position.set(0.18, -0.05, 0);
            leftPauldrons.rotation.z = Math.PI / 2;
            leftShoulder.add(leftPauldrons);
            const rightPauldrons = leftPauldrons.clone();
            rightPauldrons.position.x *= -1;
            rightPauldrons.rotation.z *= -1;
            rightShoulder.add(rightPauldrons);
        }
    });

    mob.userData.mob = true;
    return mob;
}

export function triggerHumanoidAttack(group) {
    const data = group?.userData?.humanoid;
    if (!data) {
        return;
    }
    data.state.attackTimer = 0.55;
}

export function updateHumanoidAnimation(group, delta, context = {}) {
    const data = group?.userData?.humanoid;
    if (!data) {
        return;
    }

    const { parts, state, dimensions } = data;
    const speed = context.speed ?? 0;
    const grounded = context.onGround !== false;
    const cycleSpeed = grounded ? THREE.MathUtils.clamp(speed * 0.32 + 1.2, 0.9, 6.0) : 3.0;
    state.movePhase += delta * cycleSpeed;
    const stride = Math.min(1, speed / 6);
    const step = Math.sin(state.movePhase) * stride;

    if (parts.leftLegUpper) {
        parts.leftLegUpper.rotation.x = step * 1.1;
    }
    if (parts.rightLegUpper) {
        parts.rightLegUpper.rotation.x = -step * 1.1;
    }
    if (parts.leftLegLower) {
        parts.leftLegLower.rotation.x = Math.max(0, -step * 0.65);
    }
    if (parts.rightLegLower) {
        parts.rightLegLower.rotation.x = Math.max(0, step * 0.65);
    }
    if (parts.leftFoot) {
        parts.leftFoot.rotation.x = Math.max(-0.25, -step * 0.45);
    }
    if (parts.rightFoot) {
        parts.rightFoot.rotation.x = Math.max(-0.25, step * 0.45);
    }
    if (parts.leftArmUpper) {
        parts.leftArmUpper.rotation.x = -step * 0.6;
        parts.leftArmUpper.rotation.y = 0;
    }
    if (parts.leftArmLower) {
        parts.leftArmLower.rotation.x = Math.max(0, step * 0.35);
    }
    if (parts.rightArmUpper) {
        parts.rightArmUpper.rotation.x = step * 0.4 - 0.25;
        parts.rightArmUpper.rotation.y = 0;
    }
    if (parts.rightArmLower) {
        parts.rightArmLower.rotation.x = Math.max(0, -step * 0.2);
    }
    if (parts.rightHand) {
        parts.rightHand.rotation.set(0, 0, 0);
        parts.rightHand.quaternion.identity();
    }

    if (!grounded) {
        if (parts.leftLegUpper) parts.leftLegUpper.rotation.x = 0.32;
        if (parts.rightLegUpper) parts.rightLegUpper.rotation.x = 0.28;
        if (parts.leftLegLower) parts.leftLegLower.rotation.x = 0.22;
        if (parts.rightLegLower) parts.rightLegLower.rotation.x = 0.2;
        if (parts.leftFoot) parts.leftFoot.rotation.x = 0.3;
        if (parts.rightFoot) parts.rightFoot.rotation.x = 0.3;
        if (parts.leftArmUpper) parts.leftArmUpper.rotation.x = -0.35;
        if (parts.rightArmUpper) parts.rightArmUpper.rotation.x = -0.18;
    }

    let swingWeight = 0;
    if (state.attackTimer > 0) {
        state.attackTimer = Math.max(0, state.attackTimer - delta);
        const progress = 1 - state.attackTimer / 0.55;
        const swing = Math.sin(progress * Math.PI) * 1.6;
        if (parts.rightArmUpper) {
            parts.rightArmUpper.rotation.x = -0.35 + swing;
            parts.rightArmUpper.rotation.y = Math.sin(progress * Math.PI) * 0.25;
        }
        if (parts.rightArmLower) {
            parts.rightArmLower.rotation.x = Math.max(0, swing * 0.75);
        }
        if (parts.weaponPivot) {
            parts.weaponPivot.rotation.x = -0.5 + swing * 0.9;
            parts.weaponPivot.rotation.z = Math.sin(progress * Math.PI) * 0.35;
        }
        swingWeight = 1;
    } else {
        if (parts.weaponPivot) {
            parts.weaponPivot.rotation.set(-0.6, 0, 0);
        }
    }

    group.updateMatrixWorld(true);

    let aimApplied = false;
    if (prepareAimData(group, context, parts, dimensions, state)) {
        const shoulder = parts.rightArmUpper;
        const elbow = parts.rightArmLower;
        if (shoulder && elbow) {
            const upperLen = dimensions?.upperArmLength ?? 0.7;
            const lowerLen = dimensions?.lowerArmLength ?? 0.6;
            const bendNormal = _planeNormal.copy(SIDE_AXIS).applyQuaternion(group.quaternion);
            shoulder.parent?.getWorldQuaternion(_parentQuat);
            _parentQuatInv.copy(_parentQuat).invert();
            if (solveArmIk(shoulder, elbow, parts.rightHand, upperLen, lowerLen, bendNormal, _parentQuatInv)) {
                const aimStrength = THREE.MathUtils.clamp(context.aimStrength ?? (swingWeight > 0 ? 1 : 0.65), 0, 1);
                if (parts.rightArmUpper) {
                    parts.rightArmUpper.quaternion.slerp(_localShoulderQuat, aimStrength);
                }
                if (parts.rightArmLower) {
                    parts.rightArmLower.quaternion.slerp(_localElbowQuat, aimStrength);
                }
                state.aimBlend = THREE.MathUtils.lerp(state.aimBlend ?? aimStrength, aimStrength, 0.25);
                aimApplied = true;
            }
        }
    }
    if (!aimApplied) {
        state.aimBlend = Math.max(0, (state.aimBlend ?? 0) - delta * 2);
    }

    const aimDir = state.aimDirectionWorld;
    let headYaw = 0;
    let headPitch = 0;
    if (aimDir && aimDir.lengthSq() > 0) {
        headPitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(aimDir.y, -0.99, 0.99)), -0.9, 0.9);
        const yaw = Math.atan2(aimDir.x, aimDir.z);
        headYaw = THREE.MathUtils.euclideanModulo(yaw - group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
        headYaw = THREE.MathUtils.clamp(headYaw, -1.1, 1.1);
    }

    if (parts.torso) {
        const twist = headYaw * 0.25 * (state.aimBlend ?? 0.6);
        parts.torso.rotation.y = THREE.MathUtils.lerp(parts.torso.rotation.y, twist, 0.2);
    }

    if (parts.weaponPivot && aimDir) {
        const yaw = Math.atan2(aimDir.x, aimDir.z);
        const yawDiff = THREE.MathUtils.euclideanModulo(yaw - group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
        const pitch = Math.asin(THREE.MathUtils.clamp(-aimDir.y, -0.99, 0.99));
        parts.weaponPivot.rotation.y = yawDiff * 0.25;
        if (state.attackTimer <= 0) {
            parts.weaponPivot.rotation.x = THREE.MathUtils.lerp(parts.weaponPivot.rotation.x, -0.55 + pitch * 0.6, 0.25);
            parts.weaponPivot.rotation.z = THREE.MathUtils.lerp(parts.weaponPivot.rotation.z, 0, 0.25);
        }
    }

    if (parts.head) {
        const lean = THREE.MathUtils.clamp(speed / 12, 0, 0.3);
        parts.head.rotation.set(-lean + headPitch * 0.45, headYaw * 0.5, 0);
    }

    if (parts.trim) {
        parts.trim.rotation.y += delta * 0.25;
    }
}

function prepareAimData(group, context, parts, dimensions, state) {
    const shoulder = parts.rightArmUpper;
    if (!shoulder) {
        return false;
    }

    shoulder.getWorldPosition(_shoulderPos);

    if (context.aimTarget) {
        _targetPos.copy(context.aimTarget);
        _aimDir.copy(_targetPos).sub(_shoulderPos);
    } else {
        if (context.aimOrigin) {
            _aimOrigin.copy(context.aimOrigin);
        } else {
            _aimOrigin.copy(_shoulderPos);
        }
        if (context.aimDirection) {
            _aimDir.copy(context.aimDirection);
        } else if (typeof context.aimHeading === 'number') {
            _ikEuler.set(context.aimPitch ?? 0, context.aimHeading, 0, 'YXZ');
            _aimDir.set(0, 0, -1).applyEuler(_ikEuler);
        } else {
            _aimDir.copy(FORWARD_AXIS).applyQuaternion(group.quaternion);
        }
        if (_aimDir.lengthSq() < 1e-6) {
            return false;
        }
        _aimDir.normalize();
        const reach = (dimensions?.upperArmLength ?? 0.7) + (dimensions?.lowerArmLength ?? 0.6);
        const distance = context.aimDistance ?? reach;
        _targetPos.copy(_aimOrigin).addScaledVector(_aimDir, distance);
    }

    if (_aimDir.lengthSq() < 1e-6) {
        return false;
    }

    _aimDir.normalize();
    state.aimDirectionWorld.copy(_aimDir);
    return true;
}

function solveArmIk(shoulder, elbow, hand, upperLen, lowerLen, bendNormal, parentInverse) {
    shoulder.getWorldPosition(_shoulderPos);
    _aimDir.copy(_targetPos).sub(_shoulderPos);
    let dist = _aimDir.length();
    if (dist < 1e-5) {
        return false;
    }
    _aimDir.divideScalar(dist);

    const maxReach = Math.max(0.12, upperLen + lowerLen - 0.001);
    dist = Math.min(dist, maxReach);
    const minReach = Math.max(0.06, Math.abs(upperLen - lowerLen) + 0.001);
    dist = Math.max(dist, minReach);

    _planeNormal.copy(bendNormal).normalize();
    if (_planeNormal.lengthSq() < 1e-6 || Math.abs(_planeNormal.dot(_aimDir)) > 0.95) {
        _planeNormal.copy(SIDE_AXIS).applyQuaternion(shoulder.parent ? shoulder.parent.getWorldQuaternion(_tmpQuat2) : new THREE.Quaternion());
        if (Math.abs(_planeNormal.dot(_aimDir)) > 0.95) {
            _planeNormal.set(0, 1, 0);
        }
    }

    _planeRight.crossVectors(_aimDir, _planeNormal).normalize();
    if (_planeRight.lengthSq() < 1e-6) {
        _planeNormal.set(0, 1, 0);
        _planeRight.crossVectors(_aimDir, _planeNormal).normalize();
    }
    _planeUp.crossVectors(_planeRight, _aimDir).normalize();

    const shoulderCos = THREE.MathUtils.clamp((upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2 * upperLen * dist), -1, 1);
    const shoulderAngle = Math.acos(shoulderCos);
    const elbowCos = THREE.MathUtils.clamp((upperLen * upperLen + lowerLen * lowerLen - dist * dist) / (2 * upperLen * lowerLen), -1, 1);
    const elbowAngle = Math.PI - Math.acos(elbowCos);
    const elbowSin = Math.sin(shoulderAngle);

    _elbowPos.copy(_shoulderPos)
        .addScaledVector(_aimDir, Math.cos(shoulderAngle) * upperLen)
        .addScaledVector(_planeUp, elbowSin * upperLen);

    _upperDir.copy(_elbowPos).sub(_shoulderPos).normalize();
    _lowerDir.copy(_targetPos).sub(_elbowPos).normalize();

    _shoulderWorldQuat.setFromUnitVectors(DOWN_AXIS, _upperDir);
    alignTwist(_shoulderWorldQuat, _planeRight, _upperDir);
    _localShoulderQuat.copy(parentInverse).multiply(_shoulderWorldQuat);

    const upperWorldQuat = _shoulderWorldQuat;
    _tmpQuat.copy(upperWorldQuat).invert();

    _elbowWorldQuat.setFromUnitVectors(DOWN_AXIS, _lowerDir);
    alignTwist(_elbowWorldQuat, _planeRight, _lowerDir);
    _localElbowQuat.copy(_tmpQuat).multiply(_elbowWorldQuat);

    if (hand) {
        const handAngle = elbowAngle - Math.PI * 0.5;
        hand.rotation.x = handAngle * 0.4;
    }

    return true;
}

function alignTwist(quaternion, desiredRight, forwardDir) {
    _tmpVec.copy(desiredRight).normalize();
    if (_tmpVec.lengthSq() < 1e-6) {
        return;
    }
    _tmpVec2.set(1, 0, 0).applyQuaternion(quaternion);
    const dot = THREE.MathUtils.clamp(_tmpVec2.dot(_tmpVec), -1, 1);
    let angle = Math.acos(dot);
    if (angle < 1e-4) {
        return;
    }
    _tmpVec3.crossVectors(_tmpVec2, _tmpVec).normalize();
    if (_tmpVec3.dot(forwardDir) < 0) {
        angle = -angle;
    }
    _tmpQuat.setFromAxisAngle(forwardDir, angle);
    quaternion.multiply(_tmpQuat);
}
