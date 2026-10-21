import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { B, block } from './blocks'
import { CHUNK, CUBE_SIDES, HEIGHT, cubeKey, type World } from './world'

/*
 * The land map in the shop: the island in miniature, one small box per block
 * you can see, inside the outlines of the cubes you own. Every cube you could
 * buy next (one sharing a face with yours) is a faint placeholder; click one
 * to set a placeholder block there, then buy it. Drag to turn, scroll to zoom.
 * It renders only when something changes, so an open shop costs nothing idle.
 */

export type Cube = [number, number, number]

const GHOST = 0x4ade80
const PICKED = 0xfbbf24
const MAX_BLOCKS = 80_000

export class LandMap {
    private readonly renderer: THREE.WebGLRenderer
    private readonly scene = new THREE.Scene()
    private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000)
    private readonly controls: OrbitControls
    private readonly content = new THREE.Group()
    private readonly ghosts: THREE.Mesh[] = []
    private readonly ray = new THREE.Raycaster()
    private readonly resize: ResizeObserver
    private hovered: THREE.Mesh | null = null
    private picked: THREE.Mesh | null = null
    private down: { x: number, y: number } | null = null
    private framed = false
    private queued = 0

    /** Called when a placeholder is set (or cleared, with null). */
    onPick: ((cube: Cube | null) => void) | null = null

    constructor(private readonly canvas: HTMLCanvasElement, private readonly world: World, private readonly canBuy: (cx: number, cy: number, cz: number) => boolean) {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
        this.renderer.setPixelRatio(Math.max(1, Math.min(window.devicePixelRatio || 1, 2)))
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2))
        const sun = new THREE.DirectionalLight(0xffffff, 1.6)
        sun.position.set(0.5, 1, 0.3)
        this.scene.add(sun, this.content)
        this.controls = new OrbitControls(this.camera, canvas)
        this.controls.enablePan = true
        this.controls.addEventListener('change', () => this.render())
        canvas.addEventListener('pointerdown', this.pointerDown)
        canvas.addEventListener('pointermove', this.pointerMove)
        canvas.addEventListener('pointerup', this.pointerUp)
        this.resize = new ResizeObserver(() => this.fit())
        this.resize.observe(canvas)
    }

    /** Builds the map again from the island (after a purchase, or on opening). */
    rebuild(player?: { x: number, y: number, z: number }) {
        this.clear()
        this.ghosts.length = 0
        this.hovered = null
        this.picked = null
        this.content.add(this.blocks())
        const owned = [...this.world.cubes].map(k => k.split(',').map(Number) as Cube)
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(CHUNK, CHUNK, CHUNK))
        for (const [cx, cy, cz] of owned) {
            const line = new THREE.LineSegments(edges.clone(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }))
            line.position.set((cx + 0.5) * CHUNK, (cy + 0.5) * CHUNK, (cz + 0.5) * CHUNK)
            this.content.add(line)
        }
        const seen = new Set<string>()
        for (const [cx, cy, cz] of owned) {
            for (const [dx, dy, dz] of CUBE_SIDES) {
                const c: Cube = [cx + dx, cy + dy, cz + dz]
                const key = cubeKey(...c)
                if (seen.has(key) || !this.canBuy(...c)) continue
                seen.add(key)
                this.content.add(this.ghost(c, edges))
            }
        }
        edges.dispose()
        if (player) {
            const marker = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3, 12), new THREE.MeshBasicMaterial({ color: 0xef4444 }))
            marker.rotation.x = Math.PI
            marker.position.set(player.x, player.y + 4, player.z)
            this.content.add(marker)
        }
        if (!this.framed) this.frame(owned)
        this.render()
    }

    /** A placeholder you can click: a faint box with a bright outline. */
    private ghost(c: Cube, edges: THREE.EdgesGeometry) {
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(CHUNK - 0.4, CHUNK - 0.4, CHUNK - 0.4),
            new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.06, depthWrite: false })
        )
        box.position.set((c[0] + 0.5) * CHUNK, (c[1] + 0.5) * CHUNK, (c[2] + 0.5) * CHUNK)
        box.userData.cube = c
        const outline = new THREE.LineSegments(edges.clone(), new THREE.LineBasicMaterial({ color: GHOST, transparent: true, opacity: 0.22 }))
        box.add(outline)
        this.ghosts.push(box)
        return box
    }

    /** Every block that shows (has air beside it), as one instanced mesh coloured by its top. */
    private blocks() {
        const w = this.world
        const open = (x: number, y: number, z: number) => {
            const id = w.get(x, y, z)
            return id === B.Air || block(id).transparent
        }
        const cells: [number, number, number, number][] = []
        for (const chunk of w.chunks.values()) {
            const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK
            for (let y = 0; y < HEIGHT; y++) {
                for (let lz = 0; lz < CHUNK; lz++) {
                    for (let lx = 0; lx < CHUNK; lx++) {
                        const x = ox + lx, z = oz + lz
                        const id = w.get(x, y, z)
                        if (id === B.Air) continue
                        if (!(open(x + 1, y, z) || open(x - 1, y, z) || open(x, y + 1, z) || open(x, y - 1, z) || open(x, y, z + 1) || open(x, y, z - 1))) continue
                        if (cells.length < MAX_BLOCKS) cells.push([x, y, z, id])
                    }
                }
            }
        }
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), Math.max(1, cells.length))
        mesh.count = cells.length
        const m = new THREE.Matrix4(), color = new THREE.Color()
        cells.forEach(([x, y, z, id], i) => {
            m.makeTranslation(x + 0.5, y + 0.5, z + 0.5)
            mesh.setMatrixAt(i, m)
            mesh.setColorAt(i, color.setHex(block(id).colors[0]))
        })
        return mesh
    }

    /** Points the camera at what you own, from above and to the south-east. */
    private frame(owned: Cube[]) {
        const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
        for (const [cx, cy, cz] of owned) {
            lo.min(new THREE.Vector3(cx, cy, cz).multiplyScalar(CHUNK))
            hi.max(new THREE.Vector3(cx + 1, cy + 1, cz + 1).multiplyScalar(CHUNK))
        }
        const centre = lo.clone().add(hi).multiplyScalar(0.5)
        const size = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, CHUNK) + 2 * CHUNK
        this.controls.target.copy(centre)
        this.camera.position.copy(centre).add(new THREE.Vector3(1, 0.9, 1.2).normalize().multiplyScalar(size * 1.05))
        this.controls.update()
        this.framed = true
    }

    /** Sets (or clears) the placeholder. */
    pick(cube: Cube | null) {
        this.picked = cube ? this.ghosts.find(g => cubeKey(...g.userData.cube as Cube) === cubeKey(...cube)) ?? null : null
        this.paint()
        this.onPick?.(this.picked ? this.picked.userData.cube as Cube : null)
    }

    private paint() {
        for (const g of this.ghosts) {
            const mat = g.material as THREE.MeshBasicMaterial
            const line = (g.children[0] as THREE.LineSegments).material as THREE.LineBasicMaterial
            const isPicked = g === this.picked, isHovered = g === this.hovered
            mat.color.setHex(isPicked ? PICKED : GHOST)
            mat.opacity = isPicked ? 0.45 : isHovered ? 0.22 : 0.06
            line.color.setHex(isPicked ? PICKED : GHOST)
            line.opacity = isPicked || isHovered ? 0.95 : 0.22
        }
        this.render()
    }

    private ghostAt(e: PointerEvent) {
        const r = this.canvas.getBoundingClientRect()
        this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera)
        return (this.ray.intersectObjects(this.ghosts, false)[0]?.object as THREE.Mesh | undefined) ?? null
    }

    private pointerDown = (e: PointerEvent) => {
        this.down = { x: e.clientX, y: e.clientY }
    }

    private pointerMove = (e: PointerEvent) => {
        if (e.buttons) return
        const g = this.ghostAt(e)
        if (g === this.hovered) return
        this.hovered = g
        this.canvas.style.cursor = g ? 'pointer' : ''
        this.paint()
    }

    /** A click (not the end of a drag) sets the placeholder on the cube under the pointer. */
    private pointerUp = (e: PointerEvent) => {
        const d = this.down
        this.down = null
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || e.button !== 0) return
        const g = this.ghostAt(e)
        this.pick(g ? g.userData.cube as Cube : null)
    }

    private fit() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight
        if (!w || !h) return
        this.renderer.setSize(w, h, false)
        this.camera.aspect = w / h
        this.camera.updateProjectionMatrix()
        this.render()
    }

    /** Renders on the next frame, once however many changes come in. */
    private render() {
        if (this.queued) return
        this.queued = requestAnimationFrame(() => {
            this.queued = 0
            this.renderer.render(this.scene, this.camera)
        })
    }

    dispose() {
        cancelAnimationFrame(this.queued)
        this.resize.disconnect()
        this.canvas.removeEventListener('pointerdown', this.pointerDown)
        this.canvas.removeEventListener('pointermove', this.pointerMove)
        this.canvas.removeEventListener('pointerup', this.pointerUp)
        this.controls.dispose()
        this.clear()
        this.renderer.dispose()
    }

    /** Empties the map, freeing what it drew with. */
    private clear() {
        for (const child of [...this.content.children]) {
            this.content.remove(child)
            child.traverse((o) => {
                const m = o as THREE.Mesh
                m.geometry?.dispose()
                const mat = m.material as THREE.Material | THREE.Material[] | undefined
                if (Array.isArray(mat)) mat.forEach(x => x.dispose())
                else mat?.dispose()
            })
        }
    }
}
