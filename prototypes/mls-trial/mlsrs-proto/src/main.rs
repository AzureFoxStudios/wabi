use std::time::Instant;

fn main() {
    let start = Instant::now();
    let now = move || start.elapsed().as_secs_f64() * 1000.0;
    for cs in [1u16, 2] {
        match mlsrs_proto::run_scenario(cs) {
            Ok(l) => println!("{}\n", l.join("\n")),
            Err(l) => {
                println!("{l}\nSCENARIO FAILED");
                std::process::exit(1)
            }
        }
    }
    let sizes: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let sizes = if sizes.is_empty() { vec![2, 10, 100] } else { sizes };
    for cs in [1u16, 2] {
        for &n in &sizes {
            // three runs, report each so variation is visible
            for _ in 0..3 {
                println!("BENCH mlsrs native cs={cs} {}", mlsrs_proto::bench(n, cs, &now).unwrap().json());
            }
        }
    }
}
