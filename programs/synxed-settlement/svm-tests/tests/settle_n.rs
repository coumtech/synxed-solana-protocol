//! End-to-end tests of the N-way `SettleN` instruction against the
//! compiled program, including its shared idempotency with `Settle`.

use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::Signer;
use synxed_settlement_svm_tests::{event, Fixture, AMOUNT, BPS, FEE, RECORD_SIZE};

const REWARDS_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

fn four_recipients(f: &Fixture) -> [Pubkey; 4] {
    [f.artist, f.studio, f.synxed, Pubkey::new_unique()]
}

#[test]
fn settles_four_ways_with_a_rewards_pool_share() {
    let mut f = Fixture::new();
    let recipients = four_recipients(&f);
    let before = f.balance(&f.payer.pubkey());

    f.settle_n(event(30), AMOUNT, &REWARDS_BPS, &recipients)
        .expect("four-way settlement succeeds");

    assert_eq!(f.balance(&recipients[0]), 7_000_000, "artist 35%");
    assert_eq!(f.balance(&recipients[1]), 7_000_000, "studio 35%");
    assert_eq!(f.balance(&recipients[2]), 4_000_000, "platform 20%");
    assert_eq!(f.balance(&recipients[3]), 2_000_000, "rewards pool 10%");
    f.assert_record(&event(30), AMOUNT);
    let rent = Rent::default().minimum_balance(RECORD_SIZE);
    assert_eq!(f.balance(&f.payer.pubkey()), before - AMOUNT - rent - FEE);
}

#[test]
fn shares_idempotency_with_the_three_way_instruction() {
    let mut f = Fixture::new();
    let recipients = four_recipients(&f);

    // Settled three-way first: the N-way form of the same event must fail.
    f.settle(event(31), AMOUNT, BPS)
        .expect("three-way settlement succeeds");
    let err = f
        .settle_n(event(31), AMOUNT, &REWARDS_BPS, &recipients)
        .expect_err("re-settling via SettleN must fail");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");
    assert_eq!(f.balance(&recipients[3]), 0, "pool never paid");

    // And the other way round.
    f.settle_n(event(32), AMOUNT, &REWARDS_BPS, &recipients)
        .expect("four-way settlement succeeds");
    let err = f
        .settle(event(32), AMOUNT, BPS)
        .expect_err("re-settling via Settle must fail");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");
}

#[test]
fn settles_a_single_share_and_the_maximum_eight() {
    let mut f = Fixture::new();
    let solo = Pubkey::new_unique();
    f.settle_n(event(33), AMOUNT, &[10_000], &[solo])
        .expect("one-way settlement succeeds");
    assert_eq!(f.balance(&solo), AMOUNT);

    let eight: Vec<Pubkey> = (0..8).map(|_| Pubkey::new_unique()).collect();
    let bps = [1_250u16; 8];
    f.settle_n(event(34), AMOUNT, &bps, &eight)
        .expect("eight-way settlement succeeds");
    for recipient in &eight {
        assert_eq!(f.balance(recipient), AMOUNT / 8);
    }
}

#[test]
fn rejects_nine_shares_and_zero_shares() {
    let mut f = Fixture::new();
    let nine: Vec<Pubkey> = (0..9).map(|_| Pubkey::new_unique()).collect();
    let err = f
        .settle_n(event(35), AMOUNT, &[1_000; 9], &nine)
        .expect_err("nine shares must be rejected");
    assert!(err.contains("InvalidInstructionData"), "got {err}");

    let err = f
        .settle_n(event(36), AMOUNT, &[], &[])
        .expect_err("zero shares must be rejected");
    assert!(err.contains("InvalidInstructionData"), "got {err}");
}

#[test]
fn rejects_a_recipient_count_that_does_not_match_the_shares() {
    let mut f = Fixture::new();
    let three = [f.artist, f.studio, f.synxed];
    let err = f
        .settle_n(event(37), AMOUNT, &REWARDS_BPS, &three)
        .expect_err("four shares with three recipients must fail");
    assert!(err.contains("NotEnoughAccountKeys"), "got {err}");
    assert_eq!(f.balance(&f.artist), 0);
}

#[test]
fn rejects_an_invalid_n_way_split() {
    let mut f = Fixture::new();
    let recipients = four_recipients(&f);
    let err = f
        .settle_n(event(38), AMOUNT, &[3_500, 3_500, 2_000, 900], &recipients)
        .expect_err("bps summing to 9900 must fail");
    assert!(err.contains("InvalidArgument"), "got {err}");
    assert_eq!(f.balance(&recipients[3]), 0);
}

#[test]
fn rejects_the_record_as_any_recipient() {
    let mut f = Fixture::new();
    let record = f.record_pda(&event(39));
    let recipients = [f.artist, f.studio, f.synxed, record];
    let err = f
        .settle_n(event(39), AMOUNT, &REWARDS_BPS, &recipients)
        .expect_err("record as a recipient must fail");
    assert!(err.contains("InvalidArgument"), "got {err}");
    assert!(f.svm.get_account(&record).is_none());
}

#[test]
fn rejects_another_events_record_as_a_recipient() {
    let mut f = Fixture::new();
    f.settle(event(41), AMOUNT, BPS)
        .expect("first event settles");
    let stuck_target = f.record_pda(&event(41));
    let recipients = [f.artist, f.studio, f.synxed, stuck_target];
    let err = f
        .settle_n(event(42), AMOUNT, &REWARDS_BPS, &recipients)
        .expect_err("paying into a program-owned record must fail");
    assert!(err.contains("InvalidArgument"), "got {err}");
    assert!(f.svm.get_account(&f.record_pda(&event(42))).is_none());
}

#[test]
fn duplicate_recipients_accumulate_their_shares() {
    let mut f = Fixture::new();
    let recipients = [f.artist, f.artist, f.studio];
    f.settle_n(event(43), AMOUNT, &[3_000, 3_000, 4_000], &recipients)
        .expect("duplicate recipients are allowed");
    assert_eq!(f.balance(&f.artist), 12_000_000);
    assert_eq!(f.balance(&f.studio), 8_000_000);
}

#[test]
fn rejects_a_read_only_recipient_and_a_wrong_system_program() {
    let mut f = Fixture::new();
    let recipients = four_recipients(&f);
    let record = f.record_pda(&event(44));
    let payer = f.payer.insecure_clone();

    let mut readonly = f.settle_n_instruction(event(44), AMOUNT, &REWARDS_BPS, &recipients, record);
    readonly.accounts[2].is_writable = false;
    let err = f
        .send(&[readonly], &[&payer], &payer.pubkey())
        .expect_err("read-only recipient must fail");
    assert!(err.contains("InvalidAccountData"), "got {err}");

    let mut wrong_system =
        f.settle_n_instruction(event(44), AMOUNT, &REWARDS_BPS, &recipients, record);
    let last = wrong_system.accounts.len() - 1;
    wrong_system.accounts[last].pubkey = Pubkey::new_unique();
    let err = f
        .send(&[wrong_system], &[&payer], &payer.pubkey())
        .expect_err("wrong system program account must fail");
    assert!(err.contains("IncorrectProgramId"), "got {err}");
    assert!(f.svm.get_account(&record).is_none());
}

#[test]
fn rejects_a_count_byte_that_lies_about_the_bps_list() {
    let mut f = Fixture::new();
    let recipients = four_recipients(&f);
    let record = f.record_pda(&event(45));
    let mut ix = f.settle_n_instruction(event(45), AMOUNT, &REWARDS_BPS, &recipients, record);
    ix.data[41] = 3; // claims three shares, carries four
    let payer = f.payer.insecure_clone();
    let err = f
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("count/length mismatch must fail");
    assert!(err.contains("InvalidInstructionData"), "got {err}");
}

#[test]
fn skips_zero_lamport_shares_without_touching_new_accounts() {
    let mut f = Fixture::new();
    let idle = Pubkey::new_unique();
    let recipients = [f.artist, f.studio, idle];
    f.settle_n(event(40), AMOUNT, &[6_000, 4_000, 0], &recipients)
        .expect("zero share is allowed");
    assert_eq!(f.balance(&f.artist), 12_000_000);
    assert_eq!(f.balance(&f.studio), 8_000_000);
    assert!(
        f.svm.get_account(&idle).is_none(),
        "no transfer to a 0 bps share"
    );
}
