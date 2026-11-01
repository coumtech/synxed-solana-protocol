//! Behaviours of the current program that docs/security-model.md documents as
//! things the program does not check, pinned so they cannot change silently.

use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use synxed_settlement_svm_tests::{event, Fixture, AMOUNT, RECORD_SIZE};

const REWARDS_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

/// "What the program does not check", item 4: the program refuses a payout to
/// this event's record or to any account it already owns, but an unsettled
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
