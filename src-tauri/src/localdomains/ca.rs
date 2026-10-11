// Tusk's local certificate authority, and the certificates it mints for `.test` names.
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DistinguishedName, DnType, ExtendedKeyUsagePurpose, GeneralSubtree, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, NameConstraints, PKCS_ECDSA_P256_SHA256,
};
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use rustls::sign::CertifiedKey;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// Leaves are valid for 30 days, so a cached one is replaced well before it runs out.
const LEAF_REUSE: Duration = Duration::from_secs(20 * 24 * 60 * 60);

pub struct Ca {
    issuer: Issuer<'static, KeyPair>,
    pub der: CertificateDer<'static>,
    leaves: Mutex<HashMap<String, (Instant, Arc<CertifiedKey>)>>,
}

pub fn ca_pem_path(dir: &Path) -> PathBuf {
    dir.join("ca.pem")
}

fn ca_key_path(dir: &Path) -> PathBuf {
    dir.join("ca-key.pem")
}

/// The CA certificate's SHA-256 fingerprint in lowercase hex.
pub(super) fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02x}")).collect()
}

/// The CA's subject and constraints. A loaded CA is rebuilt from these, since the issuer only needs the subject,
/// key usages, and key identifier method, which match the saved certificate.
fn ca_params() -> CertificateParams {
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, "Tusk Local CA");
    params.distinguished_name.push(DnType::OrganizationName, "Tusk");
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    // Only names under `.test`, and no IP addresses, so even a leaked key can't sign a real site.
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: vec![GeneralSubtree::DnsName("test".into())],
        excluded_subtrees: vec![GeneralSubtree::IpAddress(CidrSubnet::V4([0; 4], [0; 4])), GeneralSubtree::IpAddress(CidrSubnet::V6([0; 16], [0; 16]))],
    });
    params
}

/// Loads the CA from `dir`, or creates it. A lock on `setup.lock` keeps two processes from creating two CAs.
pub fn ensure(dir: &Path) -> Result<Ca, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("setup.lock")).map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    if let (Ok(cert), Ok(key)) = (fs::read(ca_pem_path(dir)), fs::read_to_string(ca_key_path(dir))) {
        if let (Ok(der), Ok(key)) = (CertificateDer::from_pem_slice(&cert), KeyPair::from_pem(&key)) {
            return Ok(Ca::new(key, der));
        }
    }
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut params = ca_params();
    params.not_before = rcgen::date_time_ymd(1970, 1, 1) + since_epoch() - DAY;
    params.not_after = params.not_before + 3653 * DAY;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    write_private(&ca_key_path(dir), &key.serialize_pem()).map_err(|e| e.to_string())?;
    fs::write(ca_pem_path(dir), cert.pem()).map_err(|e| e.to_string())?;
    Ok(Ca::new(key, cert.der().clone()))
}

/// The time since 1970, to add to `date_time_ymd(1970, 1, 1)`, which saves depending on the `time` crate.
fn since_epoch() -> Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = fs::remove_file(path);
    fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(path)?.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    fs::write(path, text)
}

impl Ca {
    fn new(key: KeyPair, der: CertificateDer<'static>) -> Self {
        Ca { issuer: Issuer::new(ca_params(), key), der, leaves: Mutex::new(HashMap::new()) }
    }

    /// A certificate for `name`, minted on first use and cached. `name` must be lowercase and under `.test`.
    pub fn leaf(&self, name: &str) -> Option<Arc<CertifiedKey>> {
        if let Some((made, leaf)) = self.leaves.lock().unwrap().get(name) {
            if made.elapsed() < LEAF_REUSE {
                return Some(leaf.clone());
            }
        }
        let leaf = Arc::new(self.mint(name).map_err(|e| eprintln!("local domains: no certificate for {name}: {e}")).ok()?);
        self.leaves.lock().unwrap().insert(name.to_string(), (Instant::now(), leaf.clone()));
        Some(leaf)
    }

    fn mint(&self, name: &str) -> Result<CertifiedKey, String> {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
        let cert = self.sign(name, &key)?;
        let signer = rustls::crypto::ring::sign::any_ecdsa_type(&PrivateKeyDer::Pkcs8(key.serialize_der().into())).map_err(|e| e.to_string())?;
        Ok(CertifiedKey::new(vec![cert], signer))
    }

    /// Signs a server certificate for `name` and `key`. macOS rejects one without a SAN and serverAuth, or valid for
    /// over 825 days.
    fn sign(&self, name: &str, key: &KeyPair) -> Result<CertificateDer<'static>, String> {
        let mut params = CertificateParams::new(vec![name.to_string()]).map_err(|e| e.to_string())?;
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, name);
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        params.not_before = rcgen::date_time_ymd(1970, 1, 1) + since_epoch() - DAY;
        params.not_after = params.not_before + 30 * DAY;
        Ok(params.signed_by(key, &self.issuer).map_err(|e| e.to_string())?.der().clone())
    }
}
