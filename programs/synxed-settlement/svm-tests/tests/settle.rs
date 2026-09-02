//! End-to-end tests of the three-way `Settle` instruction inside an
//! in-process SVM (LiteSVM). These exercise the real on-chain binary, so
//! they cover the processor paths the host unit tests cannot: PDA checks,
//! record creation, idempotency, and the pre-funding attack the record
//! creation path defends against.

use solana_sdk::account::Account;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::{Keypair, Signer};
use solana_system_interface::instruction as system_instruction;
use synxed_settlement_svm_tests::{event, Fixture, AMOUNT, BPS, FEE, RECORD_SIZE};

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
    assert_eq!(f.balance(&f.payer.pubkey()), before - AMOUNT - rent - FEE);
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
        payer_before - AMOUNT - (record_floor - grief_lamports) - FEE,
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
        payer_before - AMOUNT - FEE,
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
    assert!(f.svm.get_account(&f.record_pda(&event(6))).is_none());
}

#[test]
fn rejects_a_recipient_equal_to_the_record() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(9));
    f.artist = record;
    let err = f
        .settle(event(9), AMOUNT, BPS)
        .expect_err("a payout to the record itself must fail");
    assert!(err.contains("InvalidArgument"), "got {err}");
    assert!(f.svm.get_account(&record).is_none(), "no record created");
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

#[test]
fn rejects_extra_trailing_accounts() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(10));
    let mut ix = f.settle_instruction(event(10), AMOUNT, BPS, record, true);
    ix.accounts.push(solana_sdk::instruction::AccountMeta::new(
        Pubkey::new_unique(),
        false,
    ));
    let payer = f.payer.insecure_clone();
    let err = f
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("account list must be exact");
    assert!(err.contains("NotEnoughAccountKeys"), "got {err}");
}
