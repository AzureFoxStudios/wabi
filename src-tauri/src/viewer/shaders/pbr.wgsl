struct Globals {
    view_proj : mat4x4<f32>,
    camera_pos : vec4<f32>,
    light_dir : vec4<f32>,
};

struct Model {
    matrix : mat4x4<f32>,
};

struct Material {
    base_color_factor : vec4<f32>,
    mr_factor : vec4<f32>,
};

@group(0) @binding(0) var<uniform> globals : Globals;
@group(1) @binding(0) var<uniform> model : Model;
@group(2) @binding(0) var<uniform> material : Material;
@group(2) @binding(1) var mat_sampler : sampler;
@group(2) @binding(2) var base_tex : texture_2d<f32>;
@group(2) @binding(3) var mr_tex : texture_2d<f32>;
@group(2) @binding(4) var normal_tex : texture_2d<f32>;

struct VsOut {
    @builtin(position) pos : vec4<f32>,
    @location(0) normal : vec3<f32>,
    @location(1) uv : vec2<f32>,
    @location(2) world_pos : vec3<f32>,
};

@vertex
fn vs_main(@location(0) position : vec3<f32>, @location(1) normal : vec3<f32>, @location(2) uv : vec2<f32>) -> VsOut {
    var out : VsOut;
    let world = model.matrix * vec4<f32>(position, 1.0);
    out.pos = globals.view_proj * world;
    out.world_pos = world.xyz;
    let nrm = model.matrix * vec4<f32>(normal, 0.0);
    out.normal = normalize(nrm.xyz);
    out.uv = uv;
    return out;
}

const PI : f32 = 3.14159265359;

fn distribution_ggx(n : vec3<f32>, h : vec3<f32>, rough : f32) -> f32 {
    let a = rough * rough;
    let a2 = a * a;
    let ndh = max(dot(n, h), 0.0);
    let ndh2 = ndh * ndh;
    let denom = (ndh2 * (a2 - 1.0) + 1.0);
    return a2 / max(PI * denom * denom, 0.0001);
}

fn geometry_schlick_ggx(nv : f32, rough : f32) -> f32 {
    let r = rough + 1.0;
    let k = (r * r) / 8.0;
    return nv / (nv * (1.0 - k) + k);
}

fn geometry_smith(n : vec3<f32>, v : vec3<f32>, l : vec3<f32>, rough : f32) -> f32 {
    let nv = max(dot(n, v), 0.0);
    let nl = max(dot(n, l), 0.0);
    return geometry_schlick_ggx(nv, rough) * geometry_schlick_ggx(nl, rough);
}

fn fresnel_schlick(cos_theta : f32, f0 : vec3<f32>) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let base_color = material.base_color_factor.rgb * textureSample(base_tex, mat_sampler, in.uv).rgb;
    let mr = textureSample(mr_tex, mat_sampler, in.uv);
    let metallic = clamp(material.mr_factor.x * mr.b, 0.0, 1.0);
    let roughness = clamp(material.mr_factor.y * mr.g, 0.04, 1.0);
    let n_tex = textureSample(normal_tex, mat_sampler, in.uv).xyz * 2.0 - vec3<f32>(1.0);
    let N = normalize(in.normal + n_tex * 0.5);

    let V = normalize(globals.camera_pos.xyz - in.world_pos);
    let L = normalize(globals.light_dir.xyz);
    let H = normalize(V + L);

    let nl = max(dot(N, L), 0.0);
    let f0 = mix(vec3<f32>(0.04), base_color, metallic);

    let ndf = distribution_ggx(N, H, roughness);
    let g = geometry_smith(N, V, L, roughness);
    let f = fresnel_schlick(max(dot(H, V), 0.0), f0);

    let numerator = ndf * g * f;
    let denominator = 4.0 * max(dot(N, V), 0.0) * nl + 0.0001;
    let specular = numerator / denominator;

    let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
    let diffuse = kd * base_color / PI;

    let ambient = base_color * 0.12;
    let color = ambient + (diffuse + specular) * nl;
    let mapped = color / (color + vec3<f32>(1.0));
    let gamma = pow(mapped, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(gamma, 1.0);
}

struct GridVsOut {
    @builtin(position) pos : vec4<f32>,
};

@vertex
fn vs_grid(@location(0) position : vec3<f32>) -> GridVsOut {
    var out : GridVsOut;
    out.pos = globals.view_proj * model.matrix * vec4<f32>(position, 1.0);
    return out;
}

@fragment
fn fs_grid() -> @location(0) vec4<f32> {
    return vec4<f32>(0.25, 0.27, 0.32, 1.0);
}
