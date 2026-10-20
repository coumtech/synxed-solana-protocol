//! Known limitation, pinned so it cannot change silently: the settlement
//! record is derived from the event id alone, so the first payer to settle an
//! event id claims it, whoever that payer is. docs/security-model.md explains
//! the impact, the integrator mitigations, and the planned fix (namespacing
//! records by a settlement authority). When that fix lands, this test is
//! expected to change: an outsider's settlement must no longer block the
//! authority's.

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use synxed_settlement_svm_tests::{encode_settle_n, event, Fixture, AMOUNT};

const PLATFORM_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

#[test]
fn any_payer_can_claim_an_unsettled_event_id_first() {
    let mut f = Fixture::new();
    let event_id = event(70);
    let record = f.record_pda(&event_id);

    // An unrelated account holder who learned the 32-byte event id (it is in
    // the instruction data of the platform's pending transaction) settles it
    // first: the smallest valid amount, one share, paid to itself.
    let outsider = Keypair::new();
    f.svm
        .airdrop(&outsider.pubkey(), LAMPORTS_PER_SOL)
        .expect("airdrop to outsider");
    let outsider_wallet = Pubkey::new_unique();
    f.svm
        .airdrop(&outsider_wallet, LAMPORTS_PER_SOL)
        .expect("airdrop to the outsider's receiving wallet");
    let squat = Instruction {
        program_id: f.program_id,
        accounts: vec![
            AccountMeta::new(outsider.pubkey(), true),
            AccountMeta::new(outsider_wallet, false),
            AccountMeta::new(record, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: encode_settle_n(event_id, 1, &[10_000]),
    };
    f.send(&[squat], &[&outsider], &outsider.pubkey())
        .expect("the program accepts any signer as payer");
    f.assert_record(&event_id, 1);

    // The platform's real settlement for the same event is now rejected as a
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
    // The record keeps the outsider's amount, which is how reconciliation
    // tells a squatted event from a real earlier settlement.
    f.assert_record(&event_id, 1);
}
