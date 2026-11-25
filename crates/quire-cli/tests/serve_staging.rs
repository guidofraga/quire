//! `quire serve` is shared by several editors (browser tabs): one opening a document must not
//! drop the images another has staged but not saved. Its own test binary, because the setting
//! holds for the whole process.

use quire_service::assets;

#[test]
fn a_document_opened_elsewhere_keeps_another_editors_staged_image() -> Result<(), Box<dyn std::error::Error>>
{
    // without the setting, opening a document releases what it doesn't use (one editor)
    let before = assets::stage(b"\x89PNG\r\n\x1a\nfirst editor".to_vec(), "png")?;
    quire_service::new_document();
    assert!(!assets::is_staged(&before), "a single editor still releases images on switching");

    assets::serve_many_editors();
    let logo = assets::stage(b"\x89PNG\r\n\x1a\nanother tab's logo".to_vec(), "png")?;
    // another tab starts a blank document, then opens one that doesn't use the logo
    quire_service::new_document();
    assert!(assets::is_staged(&logo), "another editor's staged image was dropped");
    Ok(())
}
