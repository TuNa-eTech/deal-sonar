//! Length-prefixed framing (`01-protocol.md §1`).
//!
//! Both Chrome Native Messaging (`stdio`) and Desktop local IPC use a 4-byte
//! little-endian `u32` byte-length prefix followed by UTF-8 JSON bytes.

use std::io::{self, Read, Write};

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::Envelope;

/// Maximum frame size from native host / desktop to Chrome extension: 1 MiB (`01-protocol.md §1`).
pub const MAX_HOST_TO_EXT_BYTES: usize = 1_048_576;

/// Maximum frame size from Chrome extension to native host / desktop: 64 MiB (`01-protocol.md §1`).
pub const MAX_EXT_TO_HOST_BYTES: usize = 67_108_864;

/// Errors returned while reading or writing length-prefixed frames.
#[derive(Debug, Error)]
pub enum FrameError {
    #[error("frame size {size} bytes exceeds maximum allowed {max} bytes")]
    FrameTooLarge { size: usize, max: usize },

    #[error("I/O error during framing: {0}")]
    Io(#[from] io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

fn validate_frame_len(size: usize, max_bytes: usize) -> Result<u32, FrameError> {
    if size > max_bytes {
        return Err(FrameError::FrameTooLarge {
            size,
            max: max_bytes,
        });
    }
    u32::try_from(size).map_err(|_| FrameError::FrameTooLarge {
        size,
        max: max_bytes,
    })
}

/// Synchronously read one 4-byte little-endian length-prefixed frame.
///
/// Returns `Ok(None)` on clean EOF before the first byte of a frame header.
/// Returns `Err(FrameError::FrameTooLarge)` **before** allocating if the declared length
/// exceeds `max_bytes`, and `Err(FrameError::Io(UnexpectedEof))` if EOF occurs mid-frame.
pub fn read_frame_sync(
    reader: &mut impl Read,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut header = [0u8; 4];
    let mut filled = 0usize;

    while filled < header.len() {
        match reader.read(&mut header[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(None);
                }
                return Err(FrameError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    format!("truncated 4-byte frame header after {filled} byte(s)"),
                )));
            }
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(FrameError::Io(err)),
        }
    }

    let size = u32::from_le_bytes(header) as usize;
    validate_frame_len(size, max_bytes)?;

    let mut payload = vec![0u8; size];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// Synchronously write one 4-byte little-endian length-prefixed frame and flush `writer`.
pub fn write_frame_sync(
    writer: &mut impl Write,
    payload: &[u8],
    max_bytes: usize,
) -> Result<(), FrameError> {
    let len = validate_frame_len(payload.len(), max_bytes)?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

/// Synchronously serialize and write a typed `Envelope` with max-size enforcement.
pub fn write_envelope_sync(
    writer: &mut impl Write,
    envelope: &Envelope,
    max_bytes: usize,
) -> Result<(), FrameError> {
    let bytes = serde_json::to_vec(envelope)?;
    write_frame_sync(writer, &bytes, max_bytes)
}

/// Synchronously read and deserialize an `Envelope` using `serde_json` (`Ok(None)` on clean EOF).
///
/// Note: receivers that need structured `protocol_mismatch` / `unknown_type` classification
/// should read raw bytes with [`read_frame_sync`] and call [`crate::parse_envelope`].
pub fn read_envelope_sync(
    reader: &mut impl Read,
    max_bytes: usize,
) -> Result<Option<Envelope>, FrameError> {
    let Some(bytes) = read_frame_sync(reader, max_bytes)? else {
        return Ok(None);
    };
    let env = serde_json::from_slice(&bytes)?;
    Ok(Some(env))
}

/// Asynchronously read one 4-byte little-endian length-prefixed frame.
///
/// Returns `Ok(None)` on clean EOF before the first header byte, and checks `max_bytes`
/// before allocating the payload buffer.
pub async fn read_frame_async<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, FrameError>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut header = [0u8; 4];
    let mut filled = 0usize;

    while filled < header.len() {
        let n = reader.read(&mut header[filled..]).await?;
        if n == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(FrameError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("truncated 4-byte frame header after {filled} byte(s)"),
            )));
        }
        filled += n;
    }

    let size = u32::from_le_bytes(header) as usize;
    validate_frame_len(size, max_bytes)?;

    let mut payload = vec![0u8; size];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

/// Asynchronously write one 4-byte little-endian length-prefixed frame and flush `writer`.
pub async fn write_frame_async<W>(
    writer: &mut W,
    payload: &[u8],
    max_bytes: usize,
) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let len = validate_frame_len(payload.len(), max_bytes)?;
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

/// Asynchronously serialize and write a typed `Envelope` with max-size enforcement.
pub async fn write_envelope_async<W>(
    writer: &mut W,
    envelope: &Envelope,
    max_bytes: usize,
) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let bytes = serde_json::to_vec(envelope)?;
    write_frame_async(writer, &bytes, max_bytes).await
}
