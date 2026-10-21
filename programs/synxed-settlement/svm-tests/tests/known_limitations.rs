//! Behaviours of the current program that docs/security-model.md documents as
//! known limitations or as things the program does not check, pinned so they
//! cannot change silently. When the planned namespaced record lands,
//! `any_payer_can_claim_an_unsettled_event_id_first` is expected to change on
//! purpose; the other two pin facts the fix is not designed to change.

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::{Keypair, Signer};
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use synxed_settlement_svm_tests::{encode_settle_n, event, Fixture, AMOUNT, FEE, RECORD_SIZE};

const REWARDS_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

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

/// Known limitation 1: the record is derived from the event id alone, so the
/// first payer to settle an event id claims it.
#[test]
fn any_payer_can_claim_an_unsettled_event_id_first() {
    let mut f = Fixture::new();
    let event_id = event(80);

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
        .settle_n(event_id, AMOUNT, &REWARDS_BPS, &recipients)
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
/// amount, so a claimant who copies the amount and pays itself produces a
/// record byte-identical to the one a genuine settlement writes.
#[test]
fn a_claimed_record_matches_a_genuine_record_byte_for_byte() {
    let event_id = event(81);

    let mut genuine = Fixture::new();
    let recipients = [
        genuine.artist,
        genuine.studio,
        genuine.synxed,
        Pubkey::new_unique(),
    ];
    genuine
        .settle_n(event_id, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("the genuine settlement succeeds");
    let genuine_record = genuine
        .svm
        .get_account(&genuine.record_pda(&event_id))
        .expect("genuine record exists");

    let mut f = Fixture::new();
    let claimant = outsider(&mut f);
    let before = f.balance(&claimant.pubkey());
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
    let claimed_record = f
        .svm
        .get_account(&f.record_pda(&event_id))
        .expect("claimed record exists");

    assert_eq!(
        claimed_record.data, genuine_record.data,
        "identical record data"
    );
    assert_eq!(claimed_record.owner, f.program_id);
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    assert_eq!(
        before - f.balance(&claimant.pubkey()),
        rent + FEE,
        "the claim cost only the record rent and one signature fee"
    );
}

/// "What the program does not check", item 4: the program refuses a payout to
/// this event's record or to any record it already owns, but an unsettled
/// event's record address is still a system account, so a payout to it is
/// accepted. Nothing can withdraw those lamports, and they become part of the
/// record when that event settles.
#[test]
fn a_payout_to_an_unsettled_events_record_address_is_locked_forever() {
    let mut f = Fixture::new();
    let later = event(83);
    let later_record = f.record_pda(&later);
    let recipients = [f.artist, f.studio, f.synxed, later_record];
    f.settle_n(event(82), AMOUNT, &REWARDS_BPS, &recipients)
        .expect("a not-yet-created record address is accepted as a recipient");
    let parked = f.balance(&later_record);
    assert_eq!(parked, AMOUNT / 10, "the rewards share went to the address");
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    assert!(
        parked > rent,
        "the parked share alone covers the record's rent"
    );

    let next = [f.artist, f.studio, f.synxed, Pubkey::new_unique()];
    f.settle_n(later, AMOUNT, &REWARDS_BPS, &next)
        .expect("the later event still settles");
    f.assert_record(&later, AMOUNT);
    assert_eq!(
        f.balance(&later_record),
        parked,
        "the parked lamports are now inside a record nothing can debit"
    );
}
