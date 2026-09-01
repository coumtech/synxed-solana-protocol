//! End-to-end tests of the compiled settlement program inside an in-process
//! SVM (LiteSVM). These exercise the real on-chain binary, so they cover the
//! processor paths the host unit tests cannot: PDA checks, record creation,
//! idempotency, and the pre-funding attack the record creation path defends
//! against.
//!
//! The instruction is encoded here independently of both the Rust and
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
use solana_system_interface::instruction as system_instruction;
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;

const PROGRAM_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/deploy/synxed_settlement.so"
);
const RECORD_SIZE: usize = 41;
const RECORD_DISCRIMINATOR: u8 = 1;
const AMOUNT: u64 = 20_000_000; // 0.02 SOL, the demo's default scaled amount
const BPS: (u16, u16, u16) = (3_500, 4_000, 2_500);

struct Fixture {
    svm: LiteSVM,
    program_id: Pubkey,
    payer: Keypair,
    artist: Pubkey,
    studio: Pubkey,
    synxed: Pubkey,
}

impl Fixture {
    fn new() -> Self {
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

    fn record_pda(&self, event_id: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[b"settlement", event_id], &self.program_id).0
    }

    fn settle_instruction(
        &self,
        event_id: [u8; 32],
        amount: u64,
        bps: (u16, u16, u16),
        record: Pubkey,
        payer_is_signer: bool,
    ) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), payer_is_signer),
                AccountMeta::new(self.artist, false),
                AccountMeta::new(self.studio, false),
                AccountMeta::new(self.synxed, false),
                AccountMeta::new(record, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            ],
            data: encode_settle(event_id, amount, bps),
        }
    }

    /// Submit a settlement signed by the payer; returns Ok(()) or the
    /// debug-formatted transaction error.
    fn settle(
        &mut self,
        event_id: [u8; 32],
        amount: u64,
        bps: (u16, u16, u16),
    ) -> Result<(), String> {
        let record = self.record_pda(&event_id);
        let ix = self.settle_instruction(event_id, amount, bps, record, true);
        self.send(&[ix], &[&self.payer.insecure_clone()], &self.payer.pubkey())
    }

    fn send(
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

    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    fn assert_record(&self, event_id: &[u8; 32], amount: u64) {
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
fn encode_settle(event_id: [u8; 32], amount: u64, bps: (u16, u16, u16)) -> Vec<u8> {
    let mut data = Vec::with_capacity(47);
    data.push(0);
    data.extend_from_slice(&event_id);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&bps.0.to_le_bytes());
    data.extend_from_slice(&bps.1.to_le_bytes());
    data.extend_from_slice(&bps.2.to_le_bytes());
    data
}

fn event(n: u8) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[0] = n;
    id[31] = 0xEE;
    id
}

#[test]
fn settles_three_ways_and_writes_the_record() {
    let mut f = Fixture::new();
    let before = f.balance(&f.payer.pubkey());

    f.settle(event(1), AMOUNT, BPS)
        .expect("settlement succeeds");

    assert_eq!(f.balance(&f.artist), 7_000_000);
    assert_eq!(f.balance(&f.studio), 8_000_000);
    assert_eq!(f.balance(&f.synxed), 5_000_000);
    f.assert_record(&event(1), AMOUNT);
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    let fee = 5_000;
    assert_eq!(f.balance(&f.payer.pubkey()), before - AMOUNT - rent - fee);
}

#[test]
fn rejects_settling_the_same_event_twice() {
    let mut f = Fixture::new();
    f.settle(event(2), AMOUNT, BPS)
        .expect("first settlement succeeds");
    let artist_after_first = f.balance(&f.artist);

    let err = f
        .settle(event(2), AMOUNT, BPS)
        .expect_err("second settlement must fail");
    assert!(
        err.contains("AccountAlreadyInitialized"),
        "expected AccountAlreadyInitialized, got {err}"
    );
    assert_eq!(f.balance(&f.artist), artist_after_first, "no double payout");
}

#[test]
fn survives_a_prefunded_record_address() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(3));

    // Attacker parks the smallest deposit the runtime allows at a fresh
    // address (the rent floor for an empty account) on the PDA before the
    // platform settles. That is below the 41-byte record's floor, so the
    // program must top up the difference rather than fail.
    let rent = Rent::default();
    let grief_lamports = rent.minimum_balance(0);
    let record_floor = rent.minimum_balance(RECORD_SIZE);
    assert!(
        grief_lamports < record_floor,
        "attack must undercut the record floor"
    );
    let attacker = Keypair::new();
    f.svm
        .airdrop(&attacker.pubkey(), LAMPORTS_PER_SOL)
        .expect("airdrop to attacker");
    let grief = system_instruction::transfer(&attacker.pubkey(), &record, grief_lamports);
    f.send(&[grief], &[&attacker], &attacker.pubkey())
        .expect("attacker can fund any address to the rent floor");
    assert_eq!(f.balance(&record), grief_lamports);
    let payer_before = f.balance(&f.payer.pubkey());

    f.settle(event(3), AMOUNT, BPS)
        .expect("settlement succeeds despite the pre-funded record");
    f.assert_record(&event(3), AMOUNT);
    assert_eq!(
        f.balance(&record),
        record_floor,
        "topped up to exactly the floor"
    );
    assert_eq!(
        f.balance(&f.payer.pubkey()),
        payer_before - AMOUNT - (record_floor - grief_lamports) - 5_000,
        "payer paid only the split, the shortfall, and the fee"
    );
    assert_eq!(f.balance(&f.artist), 7_000_000);
}

#[test]
fn keeps_excess_lamports_on_an_overfunded_record() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(4));
    let attacker = Keypair::new();
    f.svm
        .airdrop(&attacker.pubkey(), 2 * LAMPORTS_PER_SOL)
        .expect("airdrop to attacker");
    let grief = system_instruction::transfer(&attacker.pubkey(), &record, LAMPORTS_PER_SOL);
    f.send(&[grief], &[&attacker], &attacker.pubkey())
        .expect("overfund the record address");
    let payer_before = f.balance(&f.payer.pubkey());

    f.settle(event(4), AMOUNT, BPS)
        .expect("settlement succeeds");
    f.assert_record(&event(4), AMOUNT);
    assert_eq!(f.balance(&record), LAMPORTS_PER_SOL, "no top-up needed");
    assert_eq!(
        f.balance(&f.payer.pubkey()),
        payer_before - AMOUNT - 5_000,
        "payer paid only the split and the fee"
    );
}

#[test]
fn rejects_a_record_address_owned_by_another_program() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(5));
    let foreign_owner = Pubkey::new_unique();
    f.svm
        .set_account(
            record,
            Account {
                lamports: LAMPORTS_PER_SOL,
                data: vec![],
                owner: foreign_owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("inject foreign-owned account");

    let err = f
        .settle(event(5), AMOUNT, BPS)
        .expect_err("foreign-owned record must be rejected");
    assert!(err.contains("InvalidAccountData"), "got {err}");
    assert_eq!(f.balance(&f.artist), 0, "nothing paid out");
}

#[test]
fn rejects_an_invalid_split_before_paying_anyone() {
    let mut f = Fixture::new();
    let err = f
        .settle(event(6), AMOUNT, (3_500, 4_000, 2_400))
        .expect_err("bps summing to 9900 must fail");
    assert!(err.contains("InvalidArgument"), "got {err}");
    assert_eq!(f.balance(&f.artist), 0);
    assert!(
        f.svm.get_account(&f.record_pda(&event(6))).is_none()
            || f.balance(&f.record_pda(&event(6))) == 0
    );
}

#[test]
fn rejects_a_wrong_record_address() {
    let mut f = Fixture::new();
    let wrong = Pubkey::new_unique();
    let ix = f.settle_instruction(event(7), AMOUNT, BPS, wrong, true);
    let payer = f.payer.insecure_clone();
    let err = f
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("non-PDA record must fail");
    assert!(err.contains("InvalidSeeds"), "got {err}");
}

#[test]
fn rejects_a_payer_that_did_not_sign() {
    let mut f = Fixture::new();
    let fee_payer = Keypair::new();
    f.svm
        .airdrop(&fee_payer.pubkey(), LAMPORTS_PER_SOL)
        .expect("airdrop to fee payer");
    let record = f.record_pda(&event(8));
    let ix = f.settle_instruction(event(8), AMOUNT, BPS, record, false);
    let err = f
        .send(&[ix], &[&fee_payer], &fee_payer.pubkey())
        .expect_err("unsigned payer must fail");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");
    assert_eq!(f.balance(&f.artist), 0);
}
