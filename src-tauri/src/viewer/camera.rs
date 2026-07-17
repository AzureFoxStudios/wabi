use glam::{Mat4, Vec3};

/// Orbit/"arcball" camera. Yaw/pitch around a target at a given distance.
pub struct Camera {
    pub target: Vec3,
    pub distance: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub fov: f32,
    pub near: f32,
    pub far: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            target: Vec3::ZERO,
            distance: 3.0,
            yaw: 0.7,
            pitch: 0.45,
            fov: 50.0_f32.to_radians(),
            near: 0.01,
            far: 2000.0,
        }
    }
}

impl Camera {
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw -= dx * 0.01;
        self.pitch -= dy * 0.01;
        self.pitch = self.pitch.clamp(-1.54, 1.54);
    }

    pub fn zoom(&mut self, delta: f32) {
        let factor = (1.0 + delta * 0.0015).clamp(0.2, 5.0);
        self.distance = (self.distance * factor).clamp(0.02, 5000.0);
    }

    pub fn pan(&mut self, dx: f32, dy: f32) {
        // Pan in the camera's screen plane.
        let right = Vec3::new(self.yaw.cos(), 0.0, -self.yaw.sin());
        let up = Vec3::new(0.0, 1.0, 0.0);
        let scale = self.distance * 0.0015;
        self.target -= right * (dx * scale) + up * (dy * scale);
    }

    fn eye(&self) -> Vec3 {
        let cp = self.pitch.cos();
        let dir = Vec3::new(cp * self.yaw.sin(), self.pitch.sin(), cp * self.yaw.cos());
        self.target + dir * self.distance
    }

    pub fn view(&self) -> Mat4 {
        Mat4::look_at_rh(self.eye(), self.target, Vec3::new(0.0, 1.0, 0.0))
    }

    pub fn proj(&self, aspect: f32) -> Mat4 {
        Mat4::perspective_rh(self.fov, aspect, self.near, self.far)
    }

    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        self.proj(aspect) * self.view()
    }
}
