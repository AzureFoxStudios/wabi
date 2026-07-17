use crate::viewer::{
    camera::Camera,
    scene::{ImageBytes, Scene, Vertex},
};
use glam::Mat4;
use std::borrow::Cow;
use wgpu::util::DeviceExt;

const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    camera_pos: [f32; 4],
    light_dir: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MatUniform {
    base_color_factor: [f32; 4],
    mr_factor: [f32; 4],
}

#[allow(dead_code)]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    globals_bgl: wgpu::BindGroupLayout,
    model_bgl: wgpu::BindGroupLayout,
    mesh_pipeline: wgpu::RenderPipeline,
    grid_pipeline: wgpu::RenderPipeline,
    depth_tex: wgpu::Texture,
    depth_view: wgpu::TextureView,
    default_base: wgpu::Texture,
    default_mr: wgpu::Texture,
    default_normal: wgpu::Texture,
    material_bgs: Vec<wgpu::BindGroup>,
    prim_buffers: Vec<(wgpu::Buffer, wgpu::Buffer, wgpu::BindGroup, u32, usize)>,
    grid_vbuf: wgpu::Buffer,
    grid_icount: u32,
    identity_bg: wgpu::BindGroup,
}

impl Renderer {
    pub async fn new(window: &winit::window::Window, scene: &Scene) -> anyhow::Result<Self> {
        let instance = wgpu::Instance::default();
        let surface = instance.create_surface(window)?;
        // The window outlives the renderer (it lives for the whole event loop),
        // so it is sound to erase the surface's borrow of it here.
        let surface: wgpu::Surface<'static> = unsafe { std::mem::transmute(surface) };
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::default(),
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .ok_or_else(|| anyhow::anyhow!("no suitable GPU adapter found"))?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: None,
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                        .using_resolution(adapter.limits()),
                },
                None,
            )
            .await?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats[0];
        let size = window.inner_size();
        let config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("failed to get surface configuration"))?;
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pbr"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("shaders/pbr.wgsl"))),
        });

        let globals_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let model_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let material_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });

        let mesh_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&globals_bgl, &model_bgl, &material_bgl],
            push_constant_ranges: &[],
        });
        let mesh_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("mesh"),
            layout: Some(&mesh_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                cull_mode: Some(wgpu::Face::Back),
                front_face: wgpu::FrontFace::Ccw,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
        });

        let grid_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&globals_bgl, &model_bgl],
            push_constant_ranges: &[],
        });
        let grid_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("grid"),
            layout: Some(&grid_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_grid",
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 12,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_grid",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
        });

        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &globals_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals_buf.as_entire_binding(),
            }],
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: None,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let white = ImageBytes { data: vec![255, 255, 255, 255], width: 1, height: 1 };
        let black = ImageBytes { data: vec![0, 0, 0, 255], width: 1, height: 1 };
        let flat_normal = ImageBytes { data: vec![128, 128, 255, 255], width: 1, height: 1 };

        let default_base = create_texture(&device, &queue, &white, "white");
        let default_mr = create_texture(&device, &queue, &black, "mr");
        let default_normal = create_texture(&device, &queue, &flat_normal, "normal");

        let mut material_bgs = Vec::new();
        for mat in &scene.materials {
            let base_view = match &mat.base_color {
                Some(i) => create_texture(&device, &queue, i, "base").create_view(&wgpu::TextureViewDescriptor::default()),
                None => default_base.create_view(&wgpu::TextureViewDescriptor::default()),
            };
            let mr_view = match &mat.metallic_roughness {
                Some(i) => create_texture(&device, &queue, i, "mr").create_view(&wgpu::TextureViewDescriptor::default()),
                None => default_mr.create_view(&wgpu::TextureViewDescriptor::default()),
            };
            let normal_view = match &mat.normal {
                Some(i) => create_texture(&device, &queue, i, "normal").create_view(&wgpu::TextureViewDescriptor::default()),
                None => default_normal.create_view(&wgpu::TextureViewDescriptor::default()),
            };

            let uniform = MatUniform {
                base_color_factor: mat.base_color_factor,
                mr_factor: [mat.metallic, mat.roughness, 0.0, 0.0],
            };
            let ubuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(std::slice::from_ref(&uniform)),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &material_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&base_view) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&mr_view) },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&normal_view) },
                ],
            });
            material_bgs.push(bg);
        }

        let mut prim_buffers = Vec::new();
        for prim in &scene.primitives {
            let vbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&prim.vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let ibuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&prim.indices),
                usage: wgpu::BufferUsages::INDEX,
            });
            let mtx = prim.model_matrix.to_cols_array();
            let mbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&mtx),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let mbg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &model_bgl,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: mbuf.as_entire_binding() }],
            });
            prim_buffers.push((vbuf, ibuf, mbg, prim.indices.len() as u32, prim.material_index));
        }

        // Identity model bind group (used by the grid).
        let identity_mtx = Mat4::IDENTITY.to_cols_array();
        let ident_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&identity_mtx),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let identity_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &model_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: ident_buf.as_entire_binding() }],
        });

        let (grid_vbuf, grid_icount) = build_grid(&device);
        let (depth_tex, depth_view) = create_depth(&device, config.width, config.height);

        Ok(Self {
            device,
            queue,
            surface,
            config,
            globals_buf,
            globals_bg,
            globals_bgl,
            model_bgl,
            mesh_pipeline,
            grid_pipeline,
            depth_tex,
            depth_view,
            default_base,
            default_mr,
            default_normal,
            material_bgs,
            prim_buffers,
            grid_vbuf,
            grid_icount,
            identity_bg,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
        let (depth_tex, depth_view) = create_depth(&self.device, self.config.width, self.config.height);
        self.depth_tex = depth_tex;
        self.depth_view = depth_view;
    }

    pub fn render(&self, camera: &Camera) {
        let aspect = self.config.width as f32 / self.config.height as f32;
        let vp = camera.view_proj(aspect);
        let cp = camera.pitch.cos();
        let dir = glam::Vec3::new(cp * camera.yaw.sin(), camera.pitch.sin(), cp * camera.yaw.cos());
        let eye = camera.target + dir * camera.distance;
        let globals = Globals {
            view_proj: vp.to_cols_array(),
            camera_pos: [eye.x, eye.y, eye.z, 1.0],
            light_dir: [0.4, 0.8, 0.3, 0.35],
        };
        self.queue
            .write_buffer(&self.globals_buf, 0, bytemuck::cast_slice(std::slice::from_ref(&globals)));

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.06, g: 0.07, b: 0.10, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pass.set_pipeline(&self.grid_pipeline);
            pass.set_bind_group(0, &self.globals_bg, &[]);
            pass.set_bind_group(1, &self.identity_bg, &[]);
            pass.set_vertex_buffer(0, self.grid_vbuf.slice(..));
            pass.draw(0..self.grid_icount, 0..1);

            pass.set_pipeline(&self.mesh_pipeline);
            pass.set_bind_group(0, &self.globals_bg, &[]);
            for (vbuf, ibuf, mbg, count, mat_idx) in &self.prim_buffers {
                pass.set_bind_group(1, mbg, &[]);
                let mi = *mat_idx;
                let mat_bg = &self.material_bgs[mi.min(self.material_bgs.len() - 1)];
                pass.set_bind_group(2, mat_bg, &[]);
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.set_index_buffer(ibuf.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..*count, 0, 0..1);
            }
        }

        self.queue.submit(Some(encoder.finish()));
        frame.present();
    }
}

fn create_texture(device: &wgpu::Device, queue: &wgpu::Queue, img: &ImageBytes, label: &str) -> wgpu::Texture {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: img.width, height: img.height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes_per_row = (img.width * 4).next_multiple_of(256);
    let mut padded = Vec::with_capacity((bytes_per_row * img.height) as usize);
    for y in 0..img.height {
        let row_start = (y * img.width * 4) as usize;
        padded.extend_from_slice(&img.data[row_start..row_start + img.width as usize * 4]);
        padded.extend(std::iter::repeat(0u8).take(bytes_per_row as usize - img.width as usize * 4));
    }
    queue.write_texture(
        tex.as_image_copy(),
        &padded,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(bytes_per_row),
            rows_per_image: Some(img.height),
        },
        wgpu::Extent3d { width: img.width, height: img.height, depth_or_array_layers: 1 },
    );
    tex
}

fn create_depth(device: &wgpu::Device, width: u32, height: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    (tex, view)
}

fn build_grid(device: &wgpu::Device) -> (wgpu::Buffer, u32) {
    let n = 10;
    let step = 1.0;
    let mut verts: Vec<f32> = Vec::new();
    for i in -n..=n {
        let p = i as f32 * step;
        verts.extend_from_slice(&[p, 0.0, -n as f32 * step]);
        verts.extend_from_slice(&[p, 0.0, n as f32 * step]);
        verts.extend_from_slice(&[-n as f32 * step, 0.0, p]);
        verts.extend_from_slice(&[n as f32 * step, 0.0, p]);
    }
    let count = verts.len() as u32 / 3;
    let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: bytemuck::cast_slice(&verts),
        usage: wgpu::BufferUsages::VERTEX,
    });
    (buf, count)
}
