//! Native Messaging host. Chrome launches this process and speaks to it over
//! stdin/stdout. Messages are length-prefixed (u32, native-endian) JSON.
//!
//! TODO: relay requests to the desktop app over local IPC. For now it answers
//! `ping` itself so the extension <-> host path can be tested end to end.

use std::io::{self, Read, Write};

use dealsonar_protocol::{Request, Response, PROTOCOL_VERSION};

fn read_message(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut buf = vec![0u8; u32::from_ne_bytes(len) as usize];
    input.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_message(output: &mut impl Write, msg: &[u8]) -> io::Result<()> {
    output.write_all(&(msg.len() as u32).to_ne_bytes())?;
    output.write_all(msg)?;
    output.flush()
}

fn handle(req: Request) -> Response {
    match req {
        Request::Ping { .. } => Response::Pong {
            version: PROTOCOL_VERSION,
        },
    }
}

fn main() -> io::Result<()> {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    while let Some(raw) = read_message(&mut stdin)? {
        let resp = match serde_json::from_slice::<Request>(&raw) {
            Ok(req) => handle(req),
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        };
        write_message(&mut stdout, &serde_json::to_vec(&resp)?)?;
    }
    Ok(())
}
