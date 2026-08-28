//! SYNXED settlement program.
//!
//! Host tests (`cargo test`) exercise split math with no Solana toolchain.
//! On-chain build requires the Solana BPF tools and `--features onchain`.

pub mod split;

#[cfg(feature = "onchain")]
pub mod instruction;
#[cfg(feature = "onchain")]
pub mod processor;
#[cfg(feature = "onchain")]
pub mod state;

#[cfg(feature = "onchain")]
solana_program::entrypoint!(processor::process_instruction);

pub use split::{
    split_three, SplitError, BPS_DENOMINATOR, DEFAULT_AMOUNT_ATOMIC, DEFAULT_ARTIST_BPS,
    DEFAULT_STUDIO_BPS, DEFAULT_SYNXED_BPS, SHARE_COUNT,
};
