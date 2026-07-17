use anyhow::{anyhow, Result};
use glam::{Mat4, Quat, Vec3};
use std::path::{Path, PathBuf};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub texcoord: [f32; 2],
}

pub struct MeshPrimitive {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub model_matrix: Mat4,
    pub material_index: usize,
}

pub struct Material {
    pub base_color_factor: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub base_color: Option<ImageBytes>,
    pub metallic_roughness: Option<ImageBytes>,
    pub normal: Option<ImageBytes>,
}

pub struct ImageBytes {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct Scene {
    pub primitives: Vec<MeshPrimitive>,
    pub materials: Vec<Material>,
    pub center: [f32; 3],
    pub radius: f32,
}

pub fn load_gltf(path: &Path) -> Result<Scene> {
    let base_dir: PathBuf = path.parent().unwrap_or(Path::new(".")).to_path_buf();

    // `Gltf::open` handles both binary glTF (GLB) and plain .gltf; for GLB the
    // binary payload is available via `blob`.
    let gltf = gltf::Gltf::open(path).map_err(|e| anyhow!("failed to parse glTF ({path:?}): {e}"))?;
    let blob = gltf.blob.clone();

    let mut buffers: Vec<Vec<u8>> = Vec::new();
    for buffer in gltf.buffers() {
        let data = match buffer.source() {
            gltf::buffer::Source::Bin => blob
                .clone()
                .ok_or_else(|| anyhow!("buffer references BIN but no binary chunk found"))?,
            gltf::buffer::Source::Uri(uri) => read_uri(uri, &base_dir)?,
        };
        buffers.push(data);
    }

    // --- materials ---
    let mut materials: Vec<Material> = Vec::new();
    for mat in gltf.materials() {
        let pbr = mat.pbr_metallic_roughness();
        let base_color = pbr
            .base_color_texture()
            .map(|t| load_image(t.texture().source().source(), &buffers, &base_dir))
            .flatten();
        let metallic_roughness = pbr
            .metallic_roughness_texture()
            .map(|t| load_image(t.texture().source().source(), &buffers, &base_dir))
            .flatten();
        let normal = mat
            .normal_texture()
            .map(|t| load_image(t.texture().source().source(), &buffers, &base_dir))
            .flatten();
        materials.push(Material {
            base_color_factor: pbr.base_color_factor(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
            base_color,
            metallic_roughness,
            normal,
        });
    }
    if materials.is_empty() {
        materials.push(Material {
            base_color_factor: [1.0, 1.0, 1.0, 1.0],
            metallic: 0.0,
            roughness: 0.8,
            base_color: None,
            metallic_roughness: None,
            normal: None,
        });
    }

    // --- meshes / primitives ---
    let mut primitives: Vec<MeshPrimitive> = Vec::new();
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];

    let mut world_matrices: std::collections::HashMap<usize, Mat4> = std::collections::HashMap::new();
    for root in gltf.nodes() {
        compute_world(&root, Mat4::IDENTITY, &mut world_matrices);
    }

    for node in gltf.nodes() {
        let world = world_matrices[&node.index()];
        let Some(mesh) = node.mesh() else { continue };
        for prim in mesh.primitives() {
            let reader = prim.reader(|buffer| Some(&buffers[buffer.index()]));
            let Some(positions) = reader.read_positions() else {
                continue;
            };
            let positions: Vec<[f32; 3]> = positions.into_iter().collect();
            let normals: Vec<[f32; 3]> = match reader.read_normals() {
                Some(n) => n.into_iter().collect(),
                None => vec![[0.0, 0.0, 0.0]; positions.len()],
            };
            let texcoords: Vec<[f32; 2]> = match reader.read_tex_coords(0) {
                Some(t) => t.into_f32().collect(),
                None => vec![[0.0, 0.0]; positions.len()],
            };
            let Some(indices) = reader.read_indices() else {
                continue;
            };
            let indices: Vec<u32> = indices.into_u32().collect();

            let vcount = positions.len();
            let mut verts = Vec::with_capacity(vcount);
            for v in 0..vcount {
                let p = positions[v];
                verts.push(Vertex {
                    position: p,
                    normal: normals[v],
                    texcoord: texcoords[v],
                });
                for a in 0..3 {
                    min[a] = min[a].min(p[a]);
                    max[a] = max[a].max(p[a]);
                }
            }

            let material_index = prim.material().index().unwrap_or(0).min(materials.len() - 1);
            primitives.push(MeshPrimitive {
                vertices: verts,
                indices,
                model_matrix: world,
                material_index,
            });
        }
    }

    if primitives.is_empty() {
        return Err(anyhow!("no renderable mesh primitives found in model"));
    }

    let center = [
        (min[0] + max[0]) / 2.0,
        (min[1] + max[1]) / 2.0,
        (min[2] + max[2]) / 2.0,
    ];
    let radius = ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2))
        .sqrt()
        .max(0.001)
        / 2.0;

    Ok(Scene {
        primitives,
        materials,
        center,
        radius,
    })
}

fn read_uri(uri: &str, base_dir: &Path) -> Result<Vec<u8>> {
    if let Some(stripped) = uri.strip_prefix("data:") {
        let comma = stripped
            .find(',')
            .ok_or_else(|| anyhow!("invalid data URI"))?;
        let b64 = &stripped[comma + 1..];
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| anyhow!("failed to decode data URI: {e}"))
    } else {
        std::fs::read(base_dir.join(uri)).map_err(|e| anyhow!("failed to read {uri}: {e}"))
    }
}

fn load_image(source: gltf::image::Source, buffers: &[Vec<u8>], base_dir: &Path) -> Option<ImageBytes> {
    let bytes = match &source {
        gltf::image::Source::View { view, .. } => {
            let buf = buffers.get(view.buffer().index())?;
            let start = view.offset();
            let end = start + view.length();
            buf.get(start..end)?.to_vec()
        }
        gltf::image::Source::Uri { uri, .. } => read_uri(uri, base_dir).ok()?,
    };
    let img = image::load_from_memory(&bytes).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Some(ImageBytes {
        data: rgba.into_raw(),
        width: w,
        height: h,
    })
}

fn compute_world(node: &gltf::Node, parent: Mat4, out: &mut std::collections::HashMap<usize, Mat4>) {
    let world = parent * local_matrix(node);
    out.insert(node.index(), world);
    for child in node.children() {
        compute_world(&child, world, out);
    }
}

fn local_matrix(node: &gltf::Node) -> Mat4 {
    match node.transform() {
        gltf::scene::Transform::Matrix { matrix } => {
            let m = [
                matrix[0][0], matrix[0][1], matrix[0][2], matrix[0][3],
                matrix[1][0], matrix[1][1], matrix[1][2], matrix[1][3],
                matrix[2][0], matrix[2][1], matrix[2][2], matrix[2][3],
                matrix[3][0], matrix[3][1], matrix[3][2], matrix[3][3],
            ];
            Mat4::from_cols_array(&m)
        }
        gltf::scene::Transform::Decomposed {
            translation,
            rotation,
            scale,
        } => {
            let t = Vec3::from(translation);
            let r = Quat::from_array(rotation);
            let s = Vec3::from(scale);
            Mat4::from_scale_rotation_translation(s, r, t)
        }
    }
}
