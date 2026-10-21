import * as THREE from 'three'
import { randomFloat } from '#shared/utils/random'
import type { LightUniforms } from './surface'

/*
 * The sky over the island, Minecraft's way: a sun and a moon (in its phase)
 * crossing a sky whose colour follows the time of day, stars at night, a
 * layer of blocky clouds drifting overhead, and the weather: rain falling in
 * the columns open to the sky, darker skies, lightning in a thunderstorm.
 * It also sets how bright the sky's light is, for the block shader.
 */

export interface SkyState {
    /** 0..1: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. */
    dayTime: number
    day: number
    weather: 'clear' | 'rain' | 'thunder'
}

export interface SkyTextures {
    sun: string
    moon: string
    clouds: string
    rain: string
}

const SKY_DAY = new THREE.Color(0x78a7ff)
const SKY_NIGHT = new THREE.Color(0x05070f)
const SKY_DUSK = new THREE.Color(0xd8805a)
const SKY_RAIN = new THREE.Color(0x5b6573)
/** Clouds sit well above the island (the world is 64 blocks tall). */
const CLOUD_Y = 108
/** One cloud texture pixel covers 12 x 12 blocks, as in Minecraft. */
const CLOUD_CELL = 12
const RAIN_RADIUS = 10

export class Sky {
    private sun: THREE.Mesh
    private moon: THREE.Mesh
    private stars: THREE.Points
    private clouds: THREE.Mesh
    private cloudMaterial: THREE.MeshBasicMaterial
    private rain: THREE.Mesh
    private rainMaterial: THREE.ShaderMaterial
    private rainKey = ''
    private rainTimer = 0
    private loader = new THREE.TextureLoader()
    private clock = 0
    /** Rain eases in and out rather than snapping (0..1). */
    private wet = 0
    /** A lightning flash, fading out (0..1). */
    private flash = 0
    private nextBolt = 5
    /** Lightning struck: the engine plays the thunder. */
    onLightning: (() => void) | null = null

    constructor(private readonly scene: THREE.Scene, textures: SkyTextures, private readonly light: LightUniforms) {
        const tex = (url: string) => {
            const t = this.loader.load(url)
            t.colorSpace = THREE.SRGBColorSpace
            t.magFilter = THREE.NearestFilter
            t.minFilter = THREE.NearestFilter
            t.generateMipmaps = false
            return t
        }
        // The sun is drawn added onto the sky, as in Minecraft (its texture is black around it).
        this.sun = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ map: tex(textures.sun), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }))
        const moonTex = tex(textures.moon)
        moonTex.repeat.set(1 / 4, 1 / 2)
        this.moon = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: moonTex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }))
        for (const m of [this.sun, this.moon]) {
            m.renderOrder = -10
            m.frustumCulled = false
            scene.add(m)
        }

        // Stars: points on a big sphere around the camera.
        const starPos = new Float32Array(900 * 3)
        for (let i = 0; i < 900; i++) {
            const u = randomFloat() * 2 - 1, a = randomFloat() * Math.PI * 2, r = Math.sqrt(1 - u * u)
            starPos.set([Math.cos(a) * r * 300, u * 300, Math.sin(a) * r * 300], i * 3)
        }
        const starGeo = new THREE.BufferGeometry()
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
        this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false }))
        this.stars.renderOrder = -11
        this.stars.frustumCulled = false
        scene.add(this.stars)

        // Clouds: one big plane with the cloud map, following the camera and drifting.
        const cloudTex = tex(textures.clouds)
        cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping
        const size = 1536
        cloudTex.repeat.set(size / (256 * CLOUD_CELL), size / (256 * CLOUD_CELL))
        this.cloudMaterial = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: 0.85, alphaTest: 0.3, side: THREE.DoubleSide, depthWrite: false })
        this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.cloudMaterial)
        this.clouds.rotation.x = -Math.PI / 2
        this.clouds.renderOrder = 1
        scene.add(this.clouds)

        // Rain: crossed quads per column, the streak texture scrolling down them.
        const rainTex = tex(textures.rain)
        rainTex.wrapS = rainTex.wrapT = THREE.RepeatWrapping
        this.rainMaterial = new THREE.ShaderMaterial({
            uniforms: { uMap: { value: rainTex }, uTime: { value: 0 }, uAlpha: { value: 0 }, uLight: { value: 1 } },
            vertexShader: /* glsl */`
                attribute float seed;
                varying vec2 vUv;
                uniform float uTime;
                void main() {
                    // Each column falls at its own pace and offset, so the streaks don't line up.
                    vUv = vec2(uv.x, uv.y + uTime * (1.4 + seed * 0.6) + seed * 7.0);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: /* glsl */`
                uniform sampler2D uMap;
                uniform float uAlpha;
                uniform float uLight;
                varying vec2 vUv;
                void main() {
                    vec4 t = texture2D(uMap, vUv);
                    if (t.a < 0.1) discard;
                    gl_FragColor = vec4(t.rgb * uLight, t.a * uAlpha);
                }`,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        })
        this.rain = new THREE.Mesh(new THREE.BufferGeometry(), this.rainMaterial)
        this.rain.frustumCulled = false
        this.rain.renderOrder = 3
        scene.add(this.rain)
    }

    /**
     * Moves the sky to the time and weather. `top` gives the height of the
     * highest block in a column (rain stops there); `camera` is the player's view.
     */
    update(dt: number, state: SkyState, camera: THREE.Camera, top: (x: number, z: number) => number) {
        this.clock += dt
        const raining = state.weather !== 'clear'
        this.wet += ((raining ? 1 : 0) - this.wet) * Math.min(1, dt * 0.4)
        const elevation = Math.sin(state.dayTime * Math.PI * 2)
        // Daylight: full from a little after sunrise, gone a little after sunset.
        const day = THREE.MathUtils.clamp(elevation * 2 + 0.5, 0, 1)
        const dusk = Math.max(0, 1 - Math.abs(elevation) * 4) * (1 - this.wet)

        // Lightning: now and then in a thunderstorm, a flash and then thunder.
        if (state.weather === 'thunder') {
            this.nextBolt -= dt
            if (this.nextBolt <= 0) {
                this.flash = 1
                this.nextBolt = 6 + randomFloat() * 18
                this.onLightning?.()
            }
        }
        this.flash = Math.max(0, this.flash - dt * 3)

        // The sky's light for the blocks: dimmer at night, under cloud, in a storm.
        const storm = state.weather === 'thunder' ? 0.55 : 0.75
        const daylight = (0.16 + 0.84 * day) * (1 - this.wet * (1 - storm))
        this.light.uSfDay.value = Math.max(daylight, this.flash * 0.9)
        const tint = this.light.uSfSkyTint.value
        tint.setRGB(1, 1, 1)
        if (elevation < 0) tint.lerp(new THREE.Color(0.62, 0.7, 1), Math.min(1, -elevation * 3))
        tint.lerp(new THREE.Color(1, 0.82, 0.66), dusk * 0.7)

        // The sky colour, and the fog the same so the island fades into it.
        const sky = new THREE.Color().copy(SKY_NIGHT).lerp(SKY_DAY, day)
        sky.lerp(SKY_DUSK, dusk * 0.6)
        sky.lerp(SKY_RAIN.clone().multiplyScalar(0.25 + 0.75 * day), this.wet * 0.85)
        sky.lerp(new THREE.Color(0xe8ecff), this.flash * 0.6)
        if (this.scene.background instanceof THREE.Color) this.scene.background.copy(sky)
        if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(sky)

        // Sun and moon cross the sky east to west, facing the camera.
        const angle = state.dayTime * Math.PI * 2
        const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.15).normalize()
        this.sun.position.copy(camera.position).addScaledVector(dir, 250)
        this.moon.position.copy(camera.position).addScaledVector(dir, -250)
        this.sun.lookAt(camera.position)
        this.moon.lookAt(camera.position)
        const clear = 1 - this.wet
        ;(this.sun.material as THREE.MeshBasicMaterial).opacity = clear
        ;(this.moon.material as THREE.MeshBasicMaterial).opacity = clear
        const phase = ((state.day % 8) + 8) % 8
        ;(this.moon.material as THREE.MeshBasicMaterial).map!.offset.set((phase % 4) / 4, phase < 4 ? 0.5 : 0)

        // Stars come out as the sky darkens (and hide behind rain clouds).
        this.stars.position.copy(camera.position)
        this.stars.rotation.z = angle
        ;(this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - day * 1.6) * clear

        // Clouds drift west, about a block every two seconds; grey and dim at night or in rain.
        const drift = this.clock * 0.6
        this.clouds.position.set(camera.position.x, CLOUD_Y, camera.position.z)
        const span = 256 * CLOUD_CELL
        this.cloudMaterial.map!.offset.set((camera.position.x + drift) / span, -camera.position.z / span)
        const cloudShade = (0.25 + 0.75 * day) * (1 - this.wet * 0.45)
        this.cloudMaterial.color.setScalar(Math.max(cloudShade, this.flash))

        // Rain.
        this.rainMaterial.uniforms.uTime!.value = this.clock
        this.rainMaterial.uniforms.uAlpha!.value = this.wet
        this.rainMaterial.uniforms.uLight!.value = 0.35 + 0.65 * this.light.uSfDay.value
        this.rain.visible = this.wet > 0.02
        this.rainTimer -= dt
        const key = `${Math.floor(camera.position.x)},${Math.floor(camera.position.z)}`
        if (this.rain.visible && (key !== this.rainKey || this.rainTimer <= 0)) {
            this.rainKey = key
            this.rainTimer = 0.5
            this.buildRain(camera.position, top)
        }
    }

    /** One crossed pair of quads per column around the camera, from the rain's ceiling down to the highest block. */
    private buildRain(at: THREE.Vector3, top: (x: number, z: number) => number) {
        const pos: number[] = [], uv: number[] = [], seed: number[] = [], idx: number[] = []
        const cx = Math.floor(at.x), cz = Math.floor(at.z)
        const ceiling = at.y + 14
        for (let x = cx - RAIN_RADIUS; x <= cx + RAIN_RADIUS; x++) {
            for (let z = cz - RAIN_RADIUS; z <= cz + RAIN_RADIUS; z++) {
                if ((x - cx) ** 2 + (z - cz) ** 2 > RAIN_RADIUS * RAIN_RADIUS) continue
                const floor = Math.max(top(x, z) + 1, at.y - 12)
                if (floor >= ceiling) continue
                const h = ceiling - floor
                // A stable random per column: which streak strip, how fast.
                const s = ((x * 73856093) ^ (z * 19349663)) >>> 0
                const strip = (s % 4) / 4
                const r = (s % 1000) / 1000
                for (const [dx0, dz0, dx1, dz1] of [[0, 0.5, 1, 0.5], [0.5, 0, 0.5, 1]]) {
                    const base = pos.length / 3
                    pos.push(x + dx0!, floor, z + dz0!, x + dx1!, floor, z + dz1!, x + dx1!, ceiling, z + dz1!, x + dx0!, ceiling, z + dz0!)
                    uv.push(strip, 0, strip + 0.25, 0, strip + 0.25, h / 4, strip, h / 4)
                    seed.push(r, r, r, r)
                    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
                }
            }
        }
        const g = this.rain.geometry
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
        g.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1))
        g.setIndex(idx)
    }

    /** How hard it is raining where the player is (0..1), for the rain sound. */
    get rainAmount() {
        return this.wet
    }

    dispose() {
        for (const m of [this.sun, this.moon, this.clouds, this.rain]) {
            m.geometry.dispose()
            const mat = m.material as THREE.Material & { map?: THREE.Texture | null, uniforms?: { uMap?: { value: THREE.Texture } } }
            mat.map?.dispose()
            mat.uniforms?.uMap?.value.dispose()
            mat.dispose()
            this.scene.remove(m)
        }
        this.stars.geometry.dispose()
        ;(this.stars.material as THREE.Material).dispose()
        this.scene.remove(this.stars)
    }
}
