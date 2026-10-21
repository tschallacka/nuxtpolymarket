import * as THREE from 'three'
import { MAX_ANIMATED, type BlockPack } from './pack'

/*
 * The material for block faces, lit the way Minecraft lights them: not by
 * lamps in the scene, but by the light level baked into each corner (sky
 * light and block light, see light.ts). The diffuse colour is the pack's
 * texture (one texture-array layer per texture, plus one per animation frame)
 * times the vertex colour (ambient occlusion, face shading, tint). The
 * brightness is the brighter of the sky light (dimmed by the time of day and
 * the weather) and the warm block light, through Minecraft's brightness curve.
 */

/** Uniforms every block material shares; the engine moves them with the clock and the weather. */
export interface LightUniforms {
    /** How bright the sky light is right now: 1 at noon, about 0.2 at midnight, less in rain. */
    uSfDay: { value: number }
    /** The colour of the sky's light (warm at dawn and dusk, cool at night). */
    uSfSkyTint: { value: THREE.Color }
    /** For things not in the world mesh (what you hold): the light where you stand, sky and block, 0..1. */
    uSfHeld: { value: THREE.Vector2 }
}

export function lightUniforms(): LightUniforms {
    return {
        uSfDay: { value: 1 },
        uSfSkyTint: { value: new THREE.Color(1, 1, 1) },
        uSfHeld: { value: new THREE.Vector2(1, 0) }
    }
}

const VERT_HEAD = /* glsl */`#include <common>
attribute float layer;
attribute float anim;
attribute vec2 light;
uniform float uSfFrames[${MAX_ANIMATED + 1}];
uniform vec2 uSfHeld;
uniform float uSfUseHeld;
varying vec2 vSfUv;
varying float vSfLayer;
varying vec2 vSfLight;`

const VERT_BODY = /* glsl */`#include <uv_vertex>
vSfUv = uv;
vSfLayer = layer + uSfFrames[int(anim + 0.5)];
vSfLight = uSfUseHeld > 0.5 ? uSfHeld : light;`

const FRAG_HEAD = /* glsl */`#include <common>
uniform highp sampler2DArray uSfAtlas;
uniform float uSfCutout;
uniform float uSfDay;
uniform vec3 uSfSkyTint;
varying vec2 vSfUv;
varying float vSfLayer;
varying vec2 vSfLight;

// Minecraft's brightness curve: level 15 is full, each step down dims faster than linearly.
float sfCurve(float l) {
    float f = clamp(l, 0.0, 1.0);
    return f / ((1.0 - f) * 3.0 + 1.0);
}`

const FRAG_BODY = /* glsl */`#include <color_fragment>
{
    vec4 sfTex = texture(uSfAtlas, vec3(clamp(vSfUv, 0.0, 1.0), floor(vSfLayer + 0.5)));
    // Overlays (the grass side's green fringe) sit on the block's own faces and
    // are see-through apart from their pixels, so even the opaque pass drops clear texels.
    if (sfTex.a < (uSfCutout > 0.5 ? 0.5 : 0.1)) discard;
    diffuseColor *= sfTex;
    vec3 sfSky = uSfSkyTint * sfCurve(vSfLight.x) * uSfDay;
    vec3 sfBlock = vec3(1.0, 0.88, 0.7) * sfCurve(vSfLight.y);
    // Never quite black, as Minecraft's darkest isn't.
    diffuseColor.rgb *= max(max(sfSky, sfBlock), vec3(0.035));
}`

export function blockMaterial(pack: BlockPack, light: LightUniforms, opts: { translucent?: boolean, cutout?: boolean, held?: boolean } = {}) {
    // Unlit by the scene: the light comes from the baked levels.
    const m = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: !!opts.translucent,
        depthWrite: !opts.translucent
    })
    m.onBeforeCompile = (shader) => {
        shader.uniforms.uSfAtlas = { value: pack.texture }
        shader.uniforms.uSfCutout = { value: opts.cutout ? 1 : 0 }
        // Shared, not copied: the pack writes the current frames into it each tick.
        shader.uniforms.uSfFrames = { value: pack.frames }
        shader.uniforms.uSfDay = light.uSfDay
        shader.uniforms.uSfSkyTint = light.uSfSkyTint
        shader.uniforms.uSfHeld = light.uSfHeld
        shader.uniforms.uSfUseHeld = { value: opts.held ? 1 : 0 }
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', VERT_HEAD)
            .replace('#include <uv_vertex>', VERT_BODY)
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', FRAG_HEAD)
            .replace('#include <color_fragment>', FRAG_BODY)
    }
    m.customProgramCacheKey = () => `skyfarm-lit-${opts.cutout ? 'cut' : 'solid'}-${opts.translucent ? 't' : 'o'}-${opts.held ? 'h' : 'w'}`
    return m
}
