use crate::viewer::camera::Camera;
use crate::viewer::renderer::Renderer;
use crate::viewer::scene::Scene;
use glam::Vec3;
use winit::event::{Event, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoop};
use winit::window::WindowBuilder;

pub fn run_app(scene: Scene) -> anyhow::Result<()> {
    crate::viewer::dlog("VIEWER: run_app entry");
    crate::viewer::dlog("VIEWER: EventLoop::new");
    let event_loop = EventLoop::new()?;
    crate::viewer::dlog("VIEWER: creating window");
    let window = WindowBuilder::new()
        .with_title("wabi model viewer")
        .with_inner_size(winit::dpi::LogicalSize::new(1024, 768))
        .build(&event_loop)?;
    crate::viewer::dlog("VIEWER: window created");

    let mut camera = Camera::default();
    camera.target = Vec3::from(scene.center);
    camera.distance = scene.radius * 3.0;

    crate::viewer::dlog("VIEWER: Renderer::new (wgpu init)");
    let mut renderer = pollster::block_on(Renderer::new(&window, &scene))?;
    crate::viewer::dlog("VIEWER: renderer ready");

    let mut dragging = false;
    let mut panning = false;
    let mut last = (0.0f32, 0.0f32);
    let mut have_last = false;

    event_loop.run(move |event, target| {
        target.set_control_flow(ControlFlow::Wait);
        match event {
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => target.exit(),
                WindowEvent::Resized(size) => {
                    if size.width > 0 && size.height > 0 {
                        renderer.resize(size.width, size.height);
                    }
                }
                WindowEvent::MouseInput { state, button, .. } => match button {
                    MouseButton::Left => {
                        dragging = state == winit::event::ElementState::Pressed;
                        have_last = false;
                    }
                    MouseButton::Right => {
                        panning = state == winit::event::ElementState::Pressed;
                        have_last = false;
                    }
                    _ => {}
                },
                WindowEvent::CursorMoved { position, .. } => {
                    let p = (position.x as f32, position.y as f32);
                    if !have_last {
                        last = p;
                        have_last = true;
                    }
                    let dx = p.0 - last.0;
                    let dy = p.1 - last.1;
                    if dragging {
                        camera.orbit(dx, dy);
                    } else if panning {
                        camera.pan(dx, dy);
                    }
                    last = p;
                }
                WindowEvent::MouseWheel { delta, .. } => {
                    let amount = match delta {
                        MouseScrollDelta::LineDelta(_, y) => y * 40.0,
                        MouseScrollDelta::PixelDelta(p) => p.y as f32,
                    };
                    camera.zoom(amount);
                }
                _ => {}
            },
            Event::AboutToWait => {
                renderer.render(&camera);
                window.request_redraw();
            }
            _ => {}
        }
    })?;
    Ok(())
}
