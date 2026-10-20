//! Known limitations of the current program, pinned so they cannot change
//! silently. docs/security-model.md explains each one, its impact, the
//! integrator mitigations, and the planned fixes. When a fix lands, the
//! matching test is expected to change on purpose.

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::{Keypair, Signer};
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use synxed_settlement_svm_tests::{encode_settle_n, event, Fixture, AMOUNT, RECORD_SIZE};

const PLATFORM_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

/// A funded account holder unrelated to the platform.
fn outsider(f: &mut Fixture) -> Keypair {
    let outsider = Keypair::new();
    f.svm
        .airdrop(&outsider.pubkey(), LAMPORTS_PER_SOL)
        .expect("airdrop to outsider");
    outsider
}

/// `SettleN` signed and paid by `payer`, with explicit recipients.
fn settle_n_as(
    f: &Fixture,
    payer: &Keypair,
    event_id: [u8; 32],
    amount: u64,
    bps: &[u16],
    recipients: &[Pubkey],
) -> Instruction {
    let mut accounts = vec![AccountMeta::new(payer.pubkey(), true)];
    accounts.extend(recipients.iter().map(|key| AccountMeta::new(*key, false)));
    accounts.push(AccountMeta::new(f.record_pda(&event_id), false));
    accounts.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
    Instruction {
        program_id: f.program_id,
        accounts,
        data: encode_settle_n(event_id, amount, bps),
    }
}

/// Security model, known limitation 1: the record is derived from the event id
/// alone, so the first payer to settle an event id claims it.
#[test]
fn any_payer_can_claim_an_unsettled_event_id_first() {
    let mut f = Fixture::new();
    let event_id = event(70);

    // An outsider who learned the 32-byte event id (it is in the instruction
    // data of the platform's pending transaction) settles it first: the
    // smallest valid amount, one share, paid to a wallet it controls. The
    // wallet is pre-funded because a 1-lamport credit to a new account would
    // fail the runtime's rent check.
    let claimant = outsider(&mut f);
    let claimant_wallet = Pubkey::new_unique();
    f.svm
        .airdrop(&claimant_wallet, LAMPORTS_PER_SOL)
        .expect("airdrop to the claimant's wallet");
    let claim = settle_n_as(&f, &claimant, event_id, 1, &[10_000], &[claimant_wallet]);
    f.send(&[claim], &[&claimant], &claimant.pubkey())
        .expect("the program accepts any signer as payer");

    // The platform's settlement for the same event is now rejected as a
    // duplicate, and none of its recipients is paid.
    let recipients = [f.artist, f.studio, f.synxed, Pubkey::new_unique()];
    let err = f
        .settle_n(event_id, AMOUNT, &PLATFORM_BPS, &recipients)
        .expect_err("the claimed event id cannot be settled again");
    assert!(
        err.contains("AccountAlreadyInitialized"),
        "expected AccountAlreadyInitialized, got {err}"
    );
    for recipient in recipients {
        assert_eq!(f.balance(&recipient), 0, "no platform payout happened");
    }
}

/// Known limitation 1, continued: the record stores only the event id and the
/// amount, so a claimant can make it identical to a genuine record by copying
/// the amount and paying itself. Nothing can be inferred from record data.
#[test]
fn a_claimed_record_can_match_a_genuine_one_exactly() {
    let mut f = Fixture::new();
    let event_id = event(72);
    let claimant = outsider(&mut f);
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    f.svm
        .airdrop(&claimant.pubkey(), AMOUNT)
        .expect("fund the copied amount");
    let before = f.balance(&claimant.pubkey());

    // One share of the platform's exact amount, paid back to the claimant.
    let claim = settle_n_as(
        &f,
        &claimant,
        event_id,
        AMOUNT,
        &[10_000],
        &[claimant.pubkey()],
    );
    f.send(&[claim], &[&claimant], &claimant.pubkey())
        .expect("the claimant may pay itself");

    f.assert_record(&event_id, AMOUNT);
    assert_eq!(
        before - f.balance(&claimant.pubkey()),
        rent + 5_000,
        "the claim cost only the record rent and one signature fee"
    );
}

/// Security model, "What the program does not check": the program refuses a
/// payout to this event's record or to any record it already owns, but an
/// unsettled event's record address is still a system account, so a payout
/// to it is accepted. When that event settles, the excess stays locked in its
/// record, because nothing can debit a program-owned record.
#[test]
fn a_payout_to_an_unsettled_events_record_address_is_locked_forever() {
    let mut f = Fixture::new();
    let later = event(74);
    let later_record = f.record_pda(&later);
    let recipients = [f.artist, f.studio, f.synxed, later_record];
    f.settle_n(event(73), AMOUNT, &PLATFORM_BPS, &recipients)
        .expect("a not-yet-created record address is accepted as a recipient");
    let parked = f.balance(&later_record);
    assert_eq!(parked, AMOUNT / 10, "the rewards share went to the address");

    f.settle_n(
        later,
        AMOUNT,
        &PLATFORM_BPS,
        &[f.artist, f.studio, f.synxed, Pubkey::new_unique()],
    )
    .expect("the later event still settles");
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    assert_eq!(
        f.balance(&later_record),
        parked.max(rent),
        "the parked lamports are now inside a record nothing can debit"
    );
}
