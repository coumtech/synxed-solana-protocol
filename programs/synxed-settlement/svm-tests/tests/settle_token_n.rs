//! End-to-end classic SPL Token settlement against the compiled program.

use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use synxed_settlement_svm_tests::{event, Fixture, TOKEN_PROGRAM_ID};

const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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

#[test]
fn rejects_token_2022_and_any_other_token_program() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    for token_program in [TOKEN_2022_PROGRAM_ID, Pubkey::new_unique()] {
        let mut ix = fixture.settle_token_n_instruction(
            event(65),
            AMOUNT,
            DECIMALS,
            &BPS,
            source,
            &recipients,
            mint,
        );
        let last = ix.accounts.len() - 1;
        ix.accounts[last] = AccountMeta::new_readonly(token_program, false);
        let payer = fixture.payer.insecure_clone();
        let err = fixture
            .send(&[ix], &[&payer], &payer.pubkey())
            .expect_err("only classic SPL Token is accepted");
        assert!(err.contains("IncorrectProgramId"), "got {err}");
    }
    assert_eq!(fixture.token_balance(&source), 100_000, "nothing moved");
    assert!(fixture
        .svm
        .get_account(&fixture.record_pda(&event(65)))
        .is_none());
}

#[test]
fn rejects_token_accounts_not_owned_by_the_token_program() {
    // Each account keeps a valid token layout but is re-owned by the system
    // program, so only the program's owner check can reject it.
    for target in ["source", "mint", "destination"] {
        let (mut fixture, mint, source, recipients) = token_fixture();
        let forged = match target {
            "source" => source,
            "mint" => mint,
            _ => recipients[0],
        };
        let mut account = fixture.svm.get_account(&forged).expect("account exists");
        account.owner = SYSTEM_PROGRAM_ID;
        fixture
            .svm
            .set_account(forged, account)
            .expect("re-own the account");
        let err = fixture
            .settle_token_n(event(66), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
            .expect_err("an account outside the token program must fail");
        assert!(err.contains("IllegalOwner"), "{target}: got {err}");
    }
}

#[test]
fn rejects_a_wrong_token_account_count() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let payer = fixture.payer.insecure_clone();

    let mut extra = fixture.settle_token_n_instruction(
        event(69),
        AMOUNT,
        DECIMALS,
        &BPS,
        source,
        &recipients,
        mint,
    );
    extra
        .accounts
        .push(AccountMeta::new(Pubkey::new_unique(), false));
    let err = fixture
        .send(&[extra], &[&payer], &payer.pubkey())
        .expect_err("an extra trailing account must fail");
    assert!(err.contains("NotEnoughAccountKeys"), "got {err}");

    let missing = fixture.settle_token_n_instruction(
        event(69),
        AMOUNT,
        DECIMALS,
        &BPS,
        source,
        &recipients[..3],
        mint,
    );
    let err = fixture
        .send(&[missing], &[&payer], &payer.pubkey())
        .expect_err("a missing destination must fail");
    assert!(err.contains("NotEnoughAccountKeys"), "got {err}");
}

#[test]
fn rejects_a_read_only_token_destination() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let mut ix = fixture.settle_token_n_instruction(
        event(70),
        AMOUNT,
        DECIMALS,
        &BPS,
        source,
        &recipients,
        mint,
    );
    ix.accounts[2].is_writable = false;
    let payer = fixture.payer.insecure_clone();
    let err = fixture
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("a read-only destination must fail");
    assert!(err.contains("InvalidAccountData"), "got {err}");
}

#[test]
fn rejects_the_record_as_a_token_destination() {
    // The record is not a token account, so the owner check rejects it before
    // the program's explicit record comparison is reached.
    let (mut fixture, mint, source, mut recipients) = token_fixture();
    recipients[0] = fixture.record_pda(&event(71));
    let err = fixture
        .settle_token_n(event(71), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("the record cannot be a destination");
    assert!(err.contains("IllegalOwner"), "got {err}");
}

#[test]
fn rejects_an_uninitialized_mint() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let mut account = fixture.svm.get_account(&mint).expect("mint exists");
    account.data[45] = 0; // is_initialized
    assert_eq!(account.owner, TOKEN_PROGRAM_ID);
    fixture
        .svm
        .set_account(mint, account)
        .expect("inject uninitialized mint");
    let err = fixture
        .settle_token_n(event(67), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("an uninitialized mint must fail");
    assert!(err.contains("UninitializedAccount"), "got {err}");
    assert_eq!(fixture.token_balance(&source), 100_000, "nothing moved");
}

#[test]
fn rejects_a_source_that_holds_another_mint() {
    let (mut fixture, mint, _source, recipients) = token_fixture();
    let other_mint = Pubkey::new_unique();
    fixture.set_mint(other_mint, DECIMALS);
    let foreign_source = Pubkey::new_unique();
    let payer = fixture.payer.pubkey();
    fixture.set_token_account(foreign_source, other_mint, payer, 100_000);
    let err = fixture
        .settle_token_n(
            event(68),
            AMOUNT,
            DECIMALS,
            &BPS,
            foreign_source,
            &recipients,
            mint,
        )
        .expect_err("the source must hold the settled mint");
    assert!(err.contains("InvalidAccountData"), "got {err}");
    assert_eq!(
        fixture.token_balance(&foreign_source),
        100_000,
        "nothing moved"
    );
}
