//! Settlement namespaces against the compiled program: opening one, who may
//! settle in it, rotating its authority, and the end of event-id claiming.
//! Also proves the retired un-namespaced instructions are refused.

use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::signature::{Keypair, Signer};
use solana_system_interface::program::ID as SYSTEM_PROGRAM_ID;
use synxed_settlement_svm_tests::{
    encode_retired, encode_settle_n, event, namespace_pda, record_pda, Fixture, AMOUNT,
    NAMESPACE_DISCRIMINATOR, NAMESPACE_ID, NAMESPACE_SIZE,
};

const REWARDS_BPS: [u16; 4] = [3_500, 3_500, 2_000, 1_000];

fn funded(f: &mut Fixture) -> Keypair {
    let key = Keypair::new();
    f.svm
        .airdrop(&key.pubkey(), LAMPORTS_PER_SOL)
        .expect("airdrop");
    key
}

fn four(f: &Fixture) -> [Pubkey; 4] {
    [f.artist, f.studio, f.synxed, Pubkey::new_unique()]
}

/// `SettleN` in `namespace`: `payer` pays and signs, `authority` sits in the
/// authority slot and is marked as a signer only if `authority_signs`.
fn settle_in(
    f: &Fixture,
    payer: &Pubkey,
    authority: &Pubkey,
    authority_signs: bool,
    namespace: Pubkey,
    event_id: [u8; 32],
    recipients: &[Pubkey; 4],
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(*authority, authority_signs),
        AccountMeta::new_readonly(namespace, false),
    ];
    accounts.extend(recipients.iter().map(|key| AccountMeta::new(*key, false)));
    accounts.push(AccountMeta::new(
        record_pda(&f.program_id, &namespace, &event_id),
        false,
    ));
    accounts.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
    Instruction {
        program_id: f.program_id,
        accounts,
        data: encode_settle_n(event_id, AMOUNT, &REWARDS_BPS),
    }
}

#[test]
fn opens_a_namespace_with_the_expected_layout() {
    let f = Fixture::new();
    let (expected, bump) = Pubkey::find_program_address(
        &[b"namespace", f.payer.pubkey().as_ref(), &NAMESPACE_ID],
        &f.program_id,
    );
    assert_eq!(f.namespace, expected);
    let account = f.svm.get_account(&f.namespace).expect("namespace exists");
    assert_eq!(account.owner, f.program_id);
    assert_eq!(account.data.len(), NAMESPACE_SIZE);
    assert_eq!(account.data[0], NAMESPACE_DISCRIMINATOR);
    assert_eq!(account.data[1], bump);
    assert_eq!(&account.data[2..34], f.payer.pubkey().as_ref(), "creator");
    assert_eq!(&account.data[34..66], &NAMESPACE_ID, "namespace id");
    assert_eq!(
        &account.data[66..98],
        f.payer.pubkey().as_ref(),
        "authority"
    );
    assert!(account.lamports >= Rent::default().minimum_balance(NAMESPACE_SIZE));
}

#[test]
fn rejects_opening_the_same_namespace_twice() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let again = f.create_namespace_instruction(&payer, &payer, NAMESPACE_ID, payer.pubkey());
    let err = f
        .send(&[again], &[&payer], &payer.pubkey())
        .expect_err("a namespace opens once");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");
}

#[test]
fn rejects_a_creator_that_did_not_sign() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let creator = Keypair::new();
    let mut ix = f.create_namespace_instruction(&payer, &creator, [9u8; 32], creator.pubkey());
    ix.accounts[1].is_signer = false;
    let err = f
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("the creator must sign");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");
}

#[test]
fn rejects_a_namespace_at_the_wrong_address() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let mut ix = f.create_namespace_instruction(&payer, &payer, [9u8; 32], payer.pubkey());
    ix.accounts[2].pubkey = namespace_pda(&f.program_id, &payer.pubkey(), &[8u8; 32]);
    let err = f
        .send(&[ix], &[&payer], &payer.pubkey())
        .expect_err("the namespace address must match the creator and id");
    assert!(err.contains("InvalidSeeds"), "got {err}");
}

#[test]
fn rejects_the_all_zero_key_as_authority() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let open = f.create_namespace_instruction(&payer, &payer, [9u8; 32], Pubkey::default());
    let err = f
        .send(&[open], &[&payer], &payer.pubkey())
        .expect_err("nobody can sign for the all-zero key");
    assert!(err.contains("InvalidArgument"), "got {err}");

    let rotate =
        f.set_namespace_authority_instruction(&payer.pubkey(), f.namespace, Pubkey::default());
    let err = f
        .send(&[rotate], &[&payer], &payer.pubkey())
        .expect_err("rotation to the all-zero key is refused");
    assert!(err.contains("InvalidArgument"), "got {err}");
}

#[test]
fn survives_a_prefunded_namespace_address() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let id = [9u8; 32];
    let address = namespace_pda(&f.program_id, &payer.pubkey(), &id);
    f.svm
        .airdrop(&address, Rent::default().minimum_balance(0))
        .expect("pre-fund the namespace address");
    let open = f.create_namespace_instruction(&payer, &payer, id, payer.pubkey());
    f.send(&[open], &[&payer], &payer.pubkey())
        .expect("a pre-funded address is topped up, not blocked");
    let account = f.svm.get_account(&address).expect("namespace exists");
    assert_eq!(account.owner, f.program_id);
    assert_eq!(account.data.len(), NAMESPACE_SIZE);
}

#[test]
fn rejects_a_namespace_address_owned_by_another_program() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let id = [9u8; 32];
    let address = namespace_pda(&f.program_id, &payer.pubkey(), &id);
    f.svm
        .set_account(
            address,
            Account {
                lamports: LAMPORTS_PER_SOL,
                data: vec![],
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("inject a foreign-owned account");
    let open = f.create_namespace_instruction(&payer, &payer, id, payer.pubkey());
    let err = f
        .send(&[open], &[&payer], &payer.pubkey())
        .expect_err("a foreign-owned account is not ours to take over");
    assert!(err.contains("InvalidAccountData"), "got {err}");
}

/// The attack the namespace closes: an outsider who learns an unsettled event
/// id can no longer settle it in the platform's namespace.
#[test]
fn outsiders_cannot_settle_in_a_namespace_they_do_not_control() {
    let mut f = Fixture::new();
    let outsider = funded(&mut f);
    let event_id = event(90);
    let recipients = four(&f);
    let namespace = f.namespace;

    // Signing as the authority with its own key: not the namespace's authority.
    let as_itself = settle_in(
        &f,
        &outsider.pubkey(),
        &outsider.pubkey(),
        true,
        namespace,
        event_id,
        &recipients,
    );
    let err = f
        .send(&[as_itself], &[&outsider], &outsider.pubkey())
        .expect_err("only the namespace authority may settle");
    assert!(err.contains("IncorrectAuthority"), "got {err}");

    // Naming the real authority without its signature.
    let authority = f.authority.pubkey();
    let unsigned = settle_in(
        &f,
        &outsider.pubkey(),
        &authority,
        false,
        namespace,
        event_id,
        &recipients,
    );
    let err = f
        .send(&[unsigned], &[&outsider], &outsider.pubkey())
        .expect_err("the authority must sign");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");

    assert!(
        f.svm.get_account(&f.record_pda(&event_id)).is_none(),
        "nothing was claimed"
    );
    f.settle_n(event_id, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("the platform settles its event");
    f.assert_record(&event_id, AMOUNT);
}

/// Settling the same event id in another namespace creates a different record
/// and does not block the platform.
#[test]
fn the_same_event_id_settles_independently_in_two_namespaces() {
    let mut f = Fixture::new();
    let outsider = funded(&mut f);
    let event_id = event(91);
    let outsider_namespace = namespace_pda(&f.program_id, &outsider.pubkey(), &NAMESPACE_ID);
    let open =
        f.create_namespace_instruction(&outsider, &outsider, NAMESPACE_ID, outsider.pubkey());
    let outsider_wallets = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let claim = settle_in(
        &f,
        &outsider.pubkey(),
        &outsider.pubkey(),
        true,
        outsider_namespace,
        event_id,
        &outsider_wallets,
    );
    f.send(&[open, claim], &[&outsider], &outsider.pubkey())
        .expect("the outsider may settle in its own namespace");

    let recipients = four(&f);
    f.settle_n(event_id, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("the platform still settles the same event id in its namespace");
    let platform_record = f.record_pda(&event_id);
    let outsider_record = record_pda(&f.program_id, &outsider_namespace, &event_id);
    assert_ne!(platform_record, outsider_record);
    assert!(f.svm.get_account(&outsider_record).is_some());
    f.assert_record(&event_id, AMOUNT);
    assert_eq!(
        f.balance(&f.artist),
        7_000_000,
        "the platform's recipients were paid"
    );
}

#[test]
fn rotation_moves_the_right_to_settle_and_keeps_idempotency() {
    let mut f = Fixture::new();
    let recipients = four(&f);
    let before = event(92);
    f.settle_n(before, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("settled under the first authority");

    let old = f.authority.insecure_clone();
    let new = funded(&mut f);
    f.rotate_authority(new.insecure_clone())
        .expect("the current authority rotates the key");

    let after = event(93);
    let namespace = f.namespace;
    let by_old = settle_in(
        &f,
        &old.pubkey(),
        &old.pubkey(),
        true,
        namespace,
        after,
        &recipients,
    );
    let err = f
        .send(&[by_old], &[&old], &old.pubkey())
        .expect_err("the old authority can no longer settle");
    assert!(err.contains("IncorrectAuthority"), "got {err}");

    f.settle_n(after, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("the new authority settles, with the payer funding");
    let err = f
        .settle_n(before, AMOUNT, &REWARDS_BPS, &recipients)
        .expect_err("an event settled before the rotation stays settled");
    assert!(err.contains("AccountAlreadyInitialized"), "got {err}");
}

#[test]
fn only_the_current_authority_can_rotate() {
    let mut f = Fixture::new();
    let outsider = funded(&mut f);
    let namespace = f.namespace;

    let by_outsider =
        f.set_namespace_authority_instruction(&outsider.pubkey(), namespace, outsider.pubkey());
    let err = f
        .send(&[by_outsider], &[&outsider], &outsider.pubkey())
        .expect_err("an outsider cannot take the namespace");
    assert!(err.contains("IncorrectAuthority"), "got {err}");

    let authority = f.authority.pubkey();
    let mut unsigned =
        f.set_namespace_authority_instruction(&authority, namespace, outsider.pubkey());
    unsigned.accounts[0].is_signer = false;
    let err = f
        .send(&[unsigned], &[&outsider], &outsider.pubkey())
        .expect_err("the authority must sign a rotation");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");

    let mut read_only =
        f.set_namespace_authority_instruction(&authority, namespace, outsider.pubkey());
    read_only.accounts[1].is_writable = false;
    let payer = f.payer.insecure_clone();
    let err = f
        .send(&[read_only], &[&payer], &payer.pubkey())
        .expect_err("a read-only namespace cannot be rotated");
    assert!(err.contains("InvalidAccountData"), "got {err}");

    let account = f.svm.get_account(&namespace).expect("namespace exists");
    assert_eq!(
        &account.data[66..98],
        authority.as_ref(),
        "authority unchanged"
    );
}

#[test]
fn rejects_an_account_that_is_not_a_namespace() {
    let mut f = Fixture::new();
    let recipients = four(&f);
    let settled = event(94);
    f.settle_n(settled, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("create a settlement record");
    let payer = f.payer.pubkey();
    let signers = f.settlement_signers();
    let refs: Vec<&Keypair> = signers.iter().collect();

    // A settlement record is owned by this program but is not a namespace.
    let record = f.record_pda(&settled);
    let with_record = settle_in(&f, &payer, &payer, true, record, event(95), &recipients);
    let err = f
        .send(&[with_record], &refs, &payer)
        .expect_err("a record is not a namespace");
    assert!(err.contains("InvalidAccountData"), "got {err}");

    // A system account is not owned by this program at all.
    let system_account = Pubkey::new_unique();
    f.svm
        .airdrop(&system_account, LAMPORTS_PER_SOL)
        .expect("fund a system account");
    let with_system = settle_in(
        &f,
        &payer,
        &payer,
        true,
        system_account,
        event(95),
        &recipients,
    );
    let err = f
        .send(&[with_system], &refs, &payer)
        .expect_err("a system account is not a namespace");
    assert!(err.contains("IllegalOwner"), "got {err}");
}

#[test]
fn rejects_the_namespace_as_a_recipient() {
    let mut f = Fixture::new();
    let recipients = [f.artist, f.studio, f.synxed, f.namespace];
    let err = f
        .settle_n(event(96), AMOUNT, &REWARDS_BPS, &recipients)
        .expect_err("nothing could withdraw a payout to the namespace");
    assert!(err.contains("InvalidArgument"), "got {err}");
}

#[test]
fn a_separate_authority_must_sign_alongside_the_payer() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let authority = Keypair::new();
    let id = [10u8; 32];
    let open = f.create_namespace_instruction(&payer, &payer, id, authority.pubkey());
    f.send(&[open], &[&payer], &payer.pubkey())
        .expect("the creator names another key as authority");
    let namespace = namespace_pda(&f.program_id, &payer.pubkey(), &id);
    let recipients = four(&f);

    let unsigned = settle_in(
        &f,
        &payer.pubkey(),
        &authority.pubkey(),
        false,
        namespace,
        event(97),
        &recipients,
    );
    let err = f
        .send(&[unsigned], &[&payer], &payer.pubkey())
        .expect_err("the payer alone cannot settle");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");

    let signed = settle_in(
        &f,
        &payer.pubkey(),
        &authority.pubkey(),
        true,
        namespace,
        event(97),
        &recipients,
    );
    f.send(&[signed], &[&payer, &authority], &payer.pubkey())
        .expect("payer and authority together settle");
    assert!(f
        .svm
        .get_account(&record_pda(&f.program_id, &namespace, &event(97)))
        .is_some());
}

#[test]
fn a_namespace_can_be_opened_and_used_in_one_transaction() {
    let mut f = Fixture::new();
    let wallet = funded(&mut f);
    let id = [11u8; 32];
    let namespace = namespace_pda(&f.program_id, &wallet.pubkey(), &id);
    let open = f.create_namespace_instruction(&wallet, &wallet, id, wallet.pubkey());
    let recipients = four(&f);
    let settle = settle_in(
        &f,
        &wallet.pubkey(),
        &wallet.pubkey(),
        true,
        namespace,
        event(98),
        &recipients,
    );
    f.send(&[open, settle], &[&wallet], &wallet.pubkey())
        .expect("open and settle in one wallet approval");
    assert!(f
        .svm
        .get_account(&record_pda(&f.program_id, &namespace, &event(98)))
        .is_some());
}

/// The original instructions keyed the record on the event id alone. They are
/// refused byte for byte, with their original account layout, and pay nobody.
#[test]
fn refuses_the_retired_instructions() {
    let mut f = Fixture::new();
    let payer = f.payer.insecure_clone();
    let recipients = [f.artist, f.studio, f.synxed];
    let event_id = event(99);
    let legacy_record = Pubkey::find_program_address(&[b"settlement", &event_id], &f.program_id).0;
    for tag in [0u8, 1, 2] {
        let mut accounts = vec![AccountMeta::new(payer.pubkey(), true)];
        accounts.extend(recipients.iter().map(|key| AccountMeta::new(*key, false)));
        accounts.push(AccountMeta::new(legacy_record, false));
        accounts.push(AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false));
        let ix = Instruction {
            program_id: f.program_id,
            accounts,
            data: encode_retired(tag, event_id, AMOUNT, &[3_500, 4_000, 2_500]),
        };
        let err = f
            .send(&[ix], &[&payer], &payer.pubkey())
            .expect_err("a retired instruction is refused");
        assert!(
            err.contains("InvalidInstructionData"),
            "tag {tag}: got {err}"
        );
    }
    assert!(f.svm.get_account(&legacy_record).is_none());
    assert_eq!(f.balance(&f.artist), 0, "nobody was paid");
}

/// The token path enforces the same authority rule as the native one.
#[test]
fn token_settlements_need_the_namespace_authority() {
    let mut f = Fixture::new();
    let outsider = funded(&mut f);
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destinations = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    f.set_mint(mint, 6);
    f.set_token_account(source, mint, outsider.pubkey(), 100_000);
    for destination in destinations {
        f.set_token_account(destination, mint, Pubkey::new_unique(), 0);
    }
    let event_id = event(100);

    let mut as_itself = f.settle_token_n_instruction(
        event_id,
        20_000,
        6,
        &REWARDS_BPS,
        source,
        &destinations,
        mint,
    );
    as_itself.accounts[0].pubkey = outsider.pubkey();
    as_itself.accounts[1].pubkey = outsider.pubkey();
    let err = f
        .send(&[as_itself], &[&outsider], &outsider.pubkey())
        .expect_err("only the namespace authority may settle tokens");
    assert!(err.contains("IncorrectAuthority"), "got {err}");

    let mut unsigned = f.settle_token_n_instruction(
        event_id,
        20_000,
        6,
        &REWARDS_BPS,
        source,
        &destinations,
        mint,
    );
    unsigned.accounts[0].pubkey = outsider.pubkey();
    unsigned.accounts[1].is_signer = false;
    let err = f
        .send(&[unsigned], &[&outsider], &outsider.pubkey())
        .expect_err("the authority must sign a token settlement");
    assert!(err.contains("MissingRequiredSignature"), "got {err}");

    assert_eq!(f.token_balance(&source), 100_000, "nothing moved");
    assert!(f.svm.get_account(&f.record_pda(&event_id)).is_none());
}

/// Both the size and the type byte identify a namespace, so a future account
/// type of either size cannot be mistaken for one. The accounts are injected:
/// the program itself never creates them.
#[test]
fn rejects_program_owned_accounts_without_the_namespace_layout() {
    let mut f = Fixture::new();
    let payer = f.payer.pubkey();
    let recipients = four(&f);
    let signers = f.settlement_signers();
    let refs: Vec<&Keypair> = signers.iter().collect();
    let shapes: [(usize, u8, &str); 3] = [
        (NAMESPACE_SIZE, 1, "namespace size, record type byte"),
        (
            NAMESPACE_SIZE + 1,
            NAMESPACE_DISCRIMINATOR,
            "one byte too long",
        ),
        (
            NAMESPACE_SIZE - 1,
            NAMESPACE_DISCRIMINATOR,
            "one byte too short",
        ),
    ];
    for (n, (size, type_byte, label)) in shapes.into_iter().enumerate() {
        let fake = Pubkey::new_unique();
        let mut data = vec![0u8; size];
        data[0] = type_byte;
        let end = size.min(98);
        data[66..end].copy_from_slice(&payer.as_ref()[..end - 66]);
        f.svm
            .set_account(
                fake,
                Account {
                    lamports: LAMPORTS_PER_SOL,
                    data,
                    owner: f.program_id,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("inject a program-owned account");
        let ix = settle_in(
            &f,
            &payer,
            &payer,
            true,
            fake,
            event(110 + n as u8),
            &recipients,
        );
        let err = f
            .send(&[ix], &refs, &payer)
            .expect_err("only the exact namespace layout is accepted");
        assert!(err.contains("InvalidAccountData"), "{label}: got {err}");
    }
}

/// The record address is derived from the namespace passed in, so the
/// authority of one namespace cannot create another namespace's record.
#[test]
fn an_outsider_cannot_create_another_namespaces_record() {
    let mut f = Fixture::new();
    let outsider = funded(&mut f);
    let event_id = event(101);
    let outsider_namespace = namespace_pda(&f.program_id, &outsider.pubkey(), &NAMESPACE_ID);
    let open =
        f.create_namespace_instruction(&outsider, &outsider, NAMESPACE_ID, outsider.pubkey());
    f.send(&[open], &[&outsider], &outsider.pubkey())
        .expect("the outsider opens its own namespace");

    let recipients = four(&f);
    let mut ix = settle_in(
        &f,
        &outsider.pubkey(),
        &outsider.pubkey(),
        true,
        outsider_namespace,
        event_id,
        &recipients,
    );
    let record_slot = ix.accounts.len() - 2;
    ix.accounts[record_slot].pubkey = f.record_pda(&event_id);
    let err = f
        .send(&[ix], &[&outsider], &outsider.pubkey())
        .expect_err("the platform's record is not derived from the outsider's namespace");
    assert!(err.contains("InvalidSeeds"), "got {err}");

    f.settle_n(event_id, AMOUNT, &REWARDS_BPS, &recipients)
        .expect("the platform's record was never created");
    f.assert_record(&event_id, AMOUNT);
}
