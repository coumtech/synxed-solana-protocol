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
    for target in 0..3 {
        let (mut fixture, mint, source, recipients) = token_fixture();
        let (target, forged) = [
            ("source", source),
            ("mint", mint),
            ("destination", recipients[0]),
        ][target];
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
    assert!(fixture
        .svm
        .get_account(&fixture.record_pda(&event(69)))
        .is_none());
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
    // Accounts: payer, source, then the destinations, so index 2 is the first.
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

#[test]
fn rejects_invalid_token_share_counts_splits_and_amounts() {
    // SettleTokenN repeats the share-count, split, and amount checks of the
    // native instructions; each must reject on the token path too.
    let (mut fixture, mint, source, recipients) = token_fixture();
    let nine = [
        1_000u16, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 2_000,
    ];
    let cases: [(&[u16], u64, &[Pubkey], &str); 4] = [
        (&nine, AMOUNT, &recipients, "InvalidInstructionData"),
        (&[], AMOUNT, &recipients[..0], "InvalidInstructionData"),
        (
            &[5_000, 5_000, 1_000],
            AMOUNT,
            &recipients[..3],
            "InvalidArgument",
        ),
        (&BPS, 0, &recipients, "InvalidArgument"),
    ];
    for (bps, amount, destinations, expected) in cases {
        let result =
            fixture.settle_token_n(event(75), amount, DECIMALS, bps, source, destinations, mint);
        let err = match result {
            Ok(()) => panic!("{bps:?} / {amount} must fail"),
            Err(err) => err,
        };
        assert!(err.contains(expected), "{bps:?} / {amount}: got {err}");
    }
    assert!(fixture
        .svm
        .get_account(&fixture.record_pda(&event(75)))
        .is_none());
}

#[test]
fn uses_transfer_checked_for_every_nonzero_token_payout() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let ix = fixture.settle_token_n_instruction(
        event(76),
        AMOUNT,
        DECIMALS,
        &[3_500, 0, 3_500, 3_000],
        source,
        &recipients,
        mint,
    );
    let payer = fixture.payer.insecure_clone();
    let inner = fixture
        .send_traced(&[ix], &[&payer], &payer.pubkey())
        .expect("settlement succeeds");
    let token_tags: Vec<u8> = inner
        .iter()
        .filter(|(program, _)| *program == TOKEN_PROGRAM_ID)
        .map(|(_, data)| data[0])
        .collect();
    // Instruction tag 12 is TransferChecked in the SPL Token program; plain
    // Transfer is tag 3. One transfer per nonzero share: the zero share in the
    // middle is skipped and the shares after it are still paid.
    assert_eq!(token_tags, vec![12, 12, 12]);
    let balances: Vec<u64> = recipients
        .iter()
        .map(|recipient| fixture.token_balance(recipient))
        .collect();
    assert_eq!(balances, vec![7_000, 0, 7_000, 6_000]);
}

#[test]
fn splits_the_largest_token_amount_exactly() {
    // The per-share product is computed in 128 bits; with 64-bit arithmetic
    // these shares would be wrong.
    let (mut fixture, mint, source, recipients) = token_fixture();
    let payer = fixture.payer.pubkey();
    fixture.set_token_account(source, mint, payer, u64::MAX);
    fixture
        .settle_token_n(
            event(77),
            u64::MAX,
            DECIMALS,
            &[5_000, 5_000],
            source,
            &recipients[..2],
            mint,
        )
        .expect("the largest amount settles");
    assert_eq!(fixture.token_balance(&recipients[0]), u64::MAX / 2);
    assert_eq!(
        fixture.token_balance(&recipients[1]),
        u64::MAX - u64::MAX / 2
    );
}

#[test]
fn a_frozen_destination_fails_the_settlement_only_when_owed_a_share() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let mut frozen = fixture
        .svm
        .get_account(&recipients[1])
        .expect("destination exists");
    frozen.data[108] = 2; // token account state: frozen
    fixture
        .svm
        .set_account(recipients[1], frozen)
        .expect("freeze the destination");

    let err = fixture
        .settle_token_n(event(78), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("a frozen destination owed a share must fail");
    // SPL Token error 17 is AccountFrozen. The whole settlement reverts.
    assert!(err.contains("Custom(17)"), "got {err}");
    assert_eq!(fixture.token_balance(&source), 100_000, "nothing moved");
    assert!(fixture
        .svm
        .get_account(&fixture.record_pda(&event(78)))
        .is_none());

    fixture
        .settle_token_n(
            event(79),
            AMOUNT,
            DECIMALS,
            &[3_500, 0, 3_500, 3_000],
            source,
            &recipients,
            mint,
        )
        .expect("a zero-token share to a frozen destination is skipped");
    assert_eq!(fixture.token_balance(&recipients[1]), 0);
    assert_eq!(
        fixture.token_balance(&recipients[3]),
        6_000,
        "later shares are paid"
    );
}

#[test]
fn a_frozen_source_fails_the_settlement() {
    let (mut fixture, mint, source, recipients) = token_fixture();
    let mut frozen = fixture.svm.get_account(&source).expect("source exists");
    frozen.data[108] = 2; // token account state: frozen
    fixture
        .svm
        .set_account(source, frozen)
        .expect("freeze the source");
    let err = fixture
        .settle_token_n(event(74), AMOUNT, DECIMALS, &BPS, source, &recipients, mint)
        .expect_err("a frozen source must fail");
    assert!(err.contains("Custom(17)"), "got {err}");
    assert!(fixture
        .svm
        .get_account(&fixture.record_pda(&event(74)))
        .is_none());
}
