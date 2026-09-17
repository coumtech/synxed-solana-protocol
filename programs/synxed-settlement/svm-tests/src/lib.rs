//! Shared fixture for the in-process SVM tests (see `tests/`).
//!
//! Instructions are encoded here independently of both the Rust and
//! TypeScript codecs on purpose: a third encoder pinned to the documented
//! layout in docs/protocol.md.

use litesvm::LiteSVM;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::Transaction;
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;

pub const PROGRAM_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/deploy/synxed_settlement.so"
);
pub const RECORD_SIZE: usize = 41;
pub const RECORD_DISCRIMINATOR: u8 = 1;
/// 0.02 SOL, the demo's default scaled amount.
pub const AMOUNT: u64 = 20_000_000;
pub const BPS: (u16, u16, u16) = (3_500, 4_000, 2_500);
/// Fee for one signature under LiteSVM's default fee structure.
pub const FEE: u64 = 5_000;
pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub struct Fixture {
    pub svm: LiteSVM,
    pub program_id: Pubkey,
    pub payer: Keypair,
    pub artist: Pubkey,
    pub studio: Pubkey,
    pub synxed: Pubkey,
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

impl Fixture {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program_id = Pubkey::new_unique();
        let so = std::fs::read(PROGRAM_SO).unwrap_or_else(|err| {
            panic!(
                "cannot read {PROGRAM_SO}: {err}. Build it first with \
                 `cargo build-sbf --manifest-path programs/synxed-settlement/Cargo.toml --features onchain`"
            )
        });
        svm.add_program(program_id, &so)
            .expect("program loads into the SVM");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL)
            .expect("airdrop to payer");
        Self {
            svm,
            program_id,
            payer,
            artist: Pubkey::new_unique(),
            studio: Pubkey::new_unique(),
            synxed: Pubkey::new_unique(),
        }
    }

    pub fn record_pda(&self, event_id: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[b"settlement", event_id], &self.program_id).0
    }

    fn accounts(
        &self,
        recipients: &[Pubkey],
        record: Pubkey,
        payer_is_signer: bool,
    ) -> Vec<AccountMeta> {
        let mut accounts = Vec::with_capacity(recipients.len() + 3);
        accounts.push(AccountMeta::new(self.payer.pubkey(), payer_is_signer));
        for recipient in recipients {
            accounts.push(AccountMeta::new(*recipient, false));
        }
        accounts.push(AccountMeta::new(record, false));
        accounts.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
        accounts
    }

    /// Three-way `Settle` instruction against the fixture's recipients.
    pub fn settle_instruction(
        &self,
        event_id: [u8; 32],
        amount: u64,
        bps: (u16, u16, u16),
        record: Pubkey,
        payer_is_signer: bool,
    ) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: self.accounts(
                &[self.artist, self.studio, self.synxed],
                record,
                payer_is_signer,
            ),
            data: encode_settle(event_id, amount, bps),
        }
    }

    /// `SettleN` instruction with explicit recipients (one per bps entry).
    pub fn settle_n_instruction(
        &self,
        event_id: [u8; 32],
        amount: u64,
        bps: &[u16],
        recipients: &[Pubkey],
        record: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: self.accounts(recipients, record, true),
            data: encode_settle_n(event_id, amount, bps),
        }
    }

    pub fn settle_token_n_instruction(
        &self,
        event_id: [u8; 32],
        amount: u64,
        decimals: u8,
        bps: &[u16],
        source: Pubkey,
        recipients: &[Pubkey],
        mint: Pubkey,
    ) -> Instruction {
        let record = self.record_pda(&event_id);
        let mut accounts = Vec::with_capacity(recipients.len() + 6);
        accounts.push(AccountMeta::new(self.payer.pubkey(), true));
        accounts.push(AccountMeta::new(source, false));
        accounts.extend(recipients.iter().map(|key| AccountMeta::new(*key, false)));
        accounts.push(AccountMeta::new_readonly(mint, false));
        accounts.push(AccountMeta::new(record, false));
        accounts.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
        Instruction {
            program_id: self.program_id,
            accounts,
            data: encode_settle_token_n(event_id, amount, decimals, bps),
        }
    }

    /// Submit a three-way settlement signed by the payer.
    pub fn settle(
        &mut self,
        event_id: [u8; 32],
        amount: u64,
        bps: (u16, u16, u16),
    ) -> Result<(), String> {
        let record = self.record_pda(&event_id);
        let ix = self.settle_instruction(event_id, amount, bps, record, true);
        self.send(&[ix], &[&self.payer.insecure_clone()], &self.payer.pubkey())
    }

    /// Submit an N-way settlement signed by the payer.
    pub fn settle_n(
        &mut self,
        event_id: [u8; 32],
        amount: u64,
        bps: &[u16],
        recipients: &[Pubkey],
    ) -> Result<(), String> {
        let record = self.record_pda(&event_id);
        let ix = self.settle_n_instruction(event_id, amount, bps, recipients, record);
        self.send(&[ix], &[&self.payer.insecure_clone()], &self.payer.pubkey())
    }

    pub fn settle_token_n(
        &mut self,
        event_id: [u8; 32],
        amount: u64,
        decimals: u8,
        bps: &[u16],
        source: Pubkey,
        recipients: &[Pubkey],
        mint: Pubkey,
    ) -> Result<(), String> {
        let ix = self
            .settle_token_n_instruction(event_id, amount, decimals, bps, source, recipients, mint);
        self.send(&[ix], &[&self.payer.insecure_clone()], &self.payer.pubkey())
    }

    pub fn set_mint(&mut self, mint: Pubkey, decimals: u8) {
        let mut data = vec![0u8; 82];
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..36].copy_from_slice(self.payer.pubkey().as_ref());
        data[44] = decimals;
        data[45] = 1;
        self.svm
            .set_account(
                mint,
                Account {
                    lamports: Rent::default().minimum_balance(data.len()),
                    data,
                    owner: TOKEN_PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("inject initialized mint");
    }

    pub fn set_token_account(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        self.svm
            .set_account(
                address,
                Account {
                    lamports: Rent::default().minimum_balance(data.len()),
                    data,
                    owner: TOKEN_PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("inject initialized token account");
    }

    pub fn token_balance(&self, address: &Pubkey) -> u64 {
        let account = self.svm.get_account(address).expect("token account exists");
        u64::from_le_bytes(account.data[64..72].try_into().expect("amount bytes"))
    }

    /// Send a transaction; returns Ok(()) or the debug-formatted error.
    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        fee_payer: &Pubkey,
    ) -> Result<(), String> {
        // Each send gets a fresh blockhash so byte-identical retries are not
        // deduplicated as "already processed" before the program runs.
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(fee_payer),
            signers,
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|failed| format!("{:?}", failed.err))
    }

    pub fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    pub fn assert_record(&self, event_id: &[u8; 32], amount: u64) {
        let record = self
            .svm
            .get_account(&self.record_pda(event_id))
            .expect("record account exists");
        assert_eq!(record.owner, self.program_id, "record owned by program");
        assert_eq!(record.data.len(), RECORD_SIZE);
        assert_eq!(record.data[0], RECORD_DISCRIMINATOR);
        assert_eq!(&record.data[1..33], event_id);
        assert_eq!(&record.data[33..41], &amount.to_le_bytes());
        assert!(
            record.lamports >= Rent::default().minimum_balance(RECORD_SIZE),
            "record is rent exempt"
        );
    }
}

/// tag(0) | event_id[32] | amount u64 LE | artist u16 LE | studio u16 LE | synxed u16 LE
pub fn encode_settle(event_id: [u8; 32], amount: u64, bps: (u16, u16, u16)) -> Vec<u8> {
    let mut data = Vec::with_capacity(47);
    data.push(0);
    data.extend_from_slice(&event_id);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&bps.0.to_le_bytes());
    data.extend_from_slice(&bps.1.to_le_bytes());
    data.extend_from_slice(&bps.2.to_le_bytes());
    data
}

/// tag(1) | event_id[32] | amount u64 LE | count u8 | bps[count] u16 LE
pub fn encode_settle_n(event_id: [u8; 32], amount: u64, bps: &[u16]) -> Vec<u8> {
    let mut data = Vec::with_capacity(42 + 2 * bps.len());
    data.push(1);
    data.extend_from_slice(&event_id);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(bps.len() as u8);
    for share in bps {
        data.extend_from_slice(&share.to_le_bytes());
    }
    data
}

/// tag(2) | event_id[32] | amount u64 LE | decimals u8 | count u8 | bps[]
pub fn encode_settle_token_n(
    event_id: [u8; 32],
    amount: u64,
    decimals: u8,
    bps: &[u16],
) -> Vec<u8> {
    let mut data = Vec::with_capacity(43 + 2 * bps.len());
    data.push(2);
    data.extend_from_slice(&event_id);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    data.push(bps.len() as u8);
    for share in bps {
        data.extend_from_slice(&share.to_le_bytes());
    }
    data
}

pub fn event(n: u8) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[0] = n;
    id[31] = 0xEE;
    id
}
