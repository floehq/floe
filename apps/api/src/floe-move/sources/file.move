module floe::file {
    use sui::object::{Self as object, UID};
    use sui::tx_context::{Self as tx_context, TxContext};
    use sui::clock::{Self, Clock};
    use sui::transfer;
    use std::option::{Self as option, Option};
    use std::string::String;
    
    public struct FileMeta has key {
        id: UID,
        blob_id: String,
        size_bytes: u64,
        mime: String,
        owner: Option<address>,
        walrus_end_epoch: Option<u64>,
        created_at: u64,
    }
    
    public fun create(
        blob_id: String,
        size_bytes: u64,
        mime: String,
        owner: Option<address>,
        walrus_end_epoch: Option<u64>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let file = FileMeta {
            id: object::new(ctx),
            blob_id,
            size_bytes,
            mime,
            owner,
            walrus_end_epoch,
            created_at: clock::timestamp_ms(clock),
        };
        transfer::transfer(file, tx_context::sender(ctx));
    }
    
    public fun create_with_owner(
        blob_id: String,
        size_bytes: u64,
        mime: String,
        owner: Option<address>,
        walrus_end_epoch: Option<u64>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let file = FileMeta {
            id: object::new(ctx),
            blob_id,
            size_bytes,
            mime,
            owner,
            walrus_end_epoch,
            created_at: clock::timestamp_ms(clock),
        };
        
        let recipient = if (option::is_some(&owner)) {
            *option::borrow(&owner)
        } else {
            tx_context::sender(ctx)
        };
        
        transfer::transfer(file, recipient);
    }
}
