mod app;
mod camera;
mod renderer;
mod scene;

use crate::viewer::app::run_app;
use crate::viewer::scene::load_gltf;
use std::fs::{File, OpenOptions};
use std::io::Write;

/// DEBUG: unbuffered append log to a file so we can see viewer progress
/// even when stderr is block-buffered (redirected to a file).
pub fn dlog(s: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open("/tmp/viewer-debug.log") {
        let _ = writeln!(f, "{}", s);
        let _ = f.flush();
    }
}

/// Spawn the native wgpu model viewer for the given model bytes.
/// Bytes are written to a temporary `.glb` and parsed; the viewer runs its own
/// winit event loop on a dedicated thread.
pub fn run_viewer(bytes: Vec<u8>) -> anyhow::Result<()> {
    dlog("run_viewer: start");
    let mut path = std::env::temp_dir();
    path.push(format!("wabi_model_{}.glb", std::process::id()));
    {
        let mut f = File::create(&path)?;
        f.write_all(&bytes)?;
    }
    let scene = match load_gltf(&path) {
        Ok(s) => {
            dlog("run_viewer: gltf loaded");
            s
        }
        Err(e) => {
            dlog(&format!("run_viewer: gltf ERR {e:#}"));
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    let _ = std::fs::remove_file(&path);
    dlog("run_viewer: calling run_app");
    run_app(scene)
}

/// DEBUG ONLY: build a minimal valid binary glTF (glb) containing a single
/// cube with a PBR material, entirely in memory (no asset files).
pub fn debug_cube_glb() -> anyhow::Result<Vec<u8>> {
    // 24 vertices (4 per face * 6 faces), pos3 + normal3, interleaved f32.
    let positions: [f32; 72] = [
        // +X
        1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0,
        // -X
        -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0,
        // +Y
        -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0,
        // -Y
        -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0,
        // +Z
        -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        // -Z
        1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0,
    ];
    let normals: [f32; 72] = [
        1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0,
        -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0,
        0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
        0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0,
    ];
    let indices: [u32; 36] = [
        0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4, 8, 9, 10, 10, 11, 8,
        12, 13, 14, 14, 15, 12, 16, 17, 18, 18, 19, 16, 20, 21, 22, 22, 23, 20,
    ];

    // Interleave pos+normal into one buffer.
    let mut interleaved: Vec<f32> = Vec::with_capacity(24 * 6);
    for i in 0..24 {
        interleaved.push(positions[i * 3]);
        interleaved.push(positions[i * 3 + 1]);
        interleaved.push(positions[i * 3 + 2]);
        interleaved.push(normals[i * 3]);
        interleaved.push(normals[i * 3 + 1]);
        interleaved.push(normals[i * 3 + 2]);
    }
    let vert_bytes: Vec<u8> = bytemuck::cast_slice(&interleaved).to_vec();
    let idx_bytes: Vec<u8> = bytemuck::cast_slice(&indices).to_vec();

    // JSON chunk (pretty + pad to 4 with spaces).
    let json = r#"{
  "scene": 0,
  "scenes": [ { "nodes": [0] } ],
  "nodes": [ { "mesh": 0 } ],
  "meshes": [ { "primitives": [ { "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2, "material": 0 } ] } ],
  "materials": [ {
    "pbrMetallicRoughness": { "baseColorFactor": [0.8, 0.2, 0.2, 1.0], "metallicFactor": 0.1, "roughnessFactor": 0.6 },
    "name": "debug-cube"
  } ],
  "buffers": [ { "byteLength": BUFLEN } ],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": VERTLEN, "byteStride": 24 },
    { "buffer": 0, "byteOffset": VERTLEN, "byteLength": IDXLEN }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3", "byteOffset": 0 },
    { "bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3", "byteOffset": 12 },
    { "bufferView": 1, "componentType": 5125, "count": 36, "type": "SCALAR" }
  ],
  "asset": { "version": "2.0", "generator": "wabi-debug" }
}"#;

    let buf_len = vert_bytes.len() + idx_bytes.len();
    let json = json
        .replace("BUFLEN", &buf_len.to_string())
        .replace("VERTLEN", &vert_bytes.len().to_string())
        .replace("IDXLEN", &idx_bytes.len().to_string());

    let json_pad = (4 - (json.len() % 4)) % 4;
    let mut json_bytes = json.into_bytes();
    for _ in 0..json_pad {
        json_bytes.push(b' ');
    }
    let bin = [&vert_bytes[..], &idx_bytes[..]].concat();
    let bin_pad = (4 - (bin.len() % 4)) % 4;
    let mut bin_bytes = bin;
    for _ in 0..bin_pad {
        bin_bytes.push(0);
    }

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    let total = 12 + 8 + json_bytes.len() + 8 + bin_bytes.len();
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin_bytes);

    Ok(out)
}
