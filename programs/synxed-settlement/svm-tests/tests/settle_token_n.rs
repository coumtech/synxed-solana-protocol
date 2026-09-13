//! End-to-end classic SPL Token settlement against the compiled program.

use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use synxed_settlement_svm_tests::{event, Fixture};

const BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];
const AMOUNT: u64 = 20_000;
const DECIMALS: u8 = 6;

fn token_fixture() -> (Fixture, Pubkey, Pubkey, [Pubkey; 4]) {
    let mut fixture = Fixture::new();
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let recipients = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    fixture.set_mint(mint, DECIMALS);
    fixture.set_token_account(source, mint, fixture.payer.pubkey(), 100_000);
    for recipient in recipients {
        fixture.set_token_account(recipient, mint, Pubkey::new_unique(), 0);
    }
    (fixture, mint, source, recipients)
}

#[test]
fn settles_four_way_token_split_and_writes_shared_record() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    fixture
        .settle_token_n(event(60), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect("token settlement succeeds");

    assert_eq!(fixture.token_balance(&source), 80_000);
    assert_eq!(fixture.token_balance(&recipients[0]), 7_000);
    assert_eq!(fixture.token_balance(&recipients[1]), 7_000);
    assert_eq!(fixture.token_balance(&recipients[2]), 4_000);
    assert_eq!(fixture.token_balance(&recipients[3]), 2_000);
    fixture.assert_record(&event(60), AMOUNT);

    let native_recipients = [
        fixture.artist,
        fixture.studio,
        fixture.synxed,
        Pubkey::new_unique(),
    ];
    let err = fixture
        .settle_n(event(60), AMOUNT, &BPS, &native_recipients)
        .expect_err("token and native modes share one idempotency record");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");

    let err = fixture
        .settle_token_n(event(60), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("same event cannot pay twice");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");
    assert_eq!(fixture.token_balance(&source), 80_000);
}

#[test]
fn rejects_wrong_destination_mint_and_source_authority() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let other_mint = Pubkey::new_unique();
    fixture.set_mint(other_mint, DECIMALS);
    fixture.set_token_account(recipients[0], other_mint, Pubkey::new_unique(), 0);
    let err = fixture
        .settle_token_n(event(63), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("destination for another mint must fail");
    assert!(err.contains("InvalidAccountData"), "got {err}");

    fixture.set_token_account(recipients[0], mint, Pubkey::new_unique(), 0);
    let wrong_source = Pubkey::new_unique();
    fixture.set_token_account(wrong_source, mint, Pubkey::new_unique(), 100_000);
    let err = fixture
        .settle_token_n(
            event(64),
            AMOUNT,
            DECIMALS,
            &BPS,
            wrong_source,
            &recipients,
            mint,
        )
        .expect_err("source authority must be the payer");
    assert!(err.contains("InvalidAccountData"), "got {err}");
}

#[test]
fn rejects_wrong_mint_decimals_and_source_as_recipient() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let err = fixture
        .settle_token_n(event(61), AMOUNT, 5, &BPS, source, &recipients, mint)
        .expect_err("wrong decimals fail");
    assert!(err.contains("InvalidAccountData"), "got {err}");

    let mut with_source = recipients;
    with_source[0] = source;
    let err = fixture
        .settle_token_n(
            event(62),
            AMOUNT,
            DECIMALS,
            &BPS,
            source,
            &with_source,
            mint,
        )
        .expect_err("source cannot be a recipient");
    assert!(err.contains("InvalidArgument"), "got {err}");
}
