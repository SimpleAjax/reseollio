//! Build script for generating protobuf code

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Compile the protobuf definitions to OUT_DIR (cargo managed)
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile(&["../proto/reseolio.proto"], &["../proto"])?;

    println!("cargo:rerun-if-changed=../proto/reseolio.proto");
    Ok(())
}
