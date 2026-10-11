// A DNS responder that answers every name under `.test` with this computer, and refuses everything else.
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::UdpSocket;

const TTL: u32 = 5;
const FORMERR: u8 = 1;
const NOTIMP: u8 = 4;
const REFUSED: u8 = 5;

/// The question's end offset, whether its name is under `test`, its type, and its class.
fn question(q: &[u8]) -> Option<(usize, bool, u16, u16)> {
    let mut i = 12;
    let mut last: &[u8] = &[];
    loop {
        let len = *q.get(i)? as usize;
        i += 1;
        if len == 0 {
            break;
        }
        // Labels are at most 63 bytes, and a question has no compression pointers.
        if len > 63 || i + len > 12 + 255 {
            return None;
        }
        last = q.get(i..i + len)?;
        i += len;
    }
    let field = |at: usize| Some(u16::from_be_bytes([*q.get(at)?, *q.get(at + 1)?]));
    Some((i + 4, last.eq_ignore_ascii_case(b"test"), field(i)?, field(i + 2)?))
}

/// The reply to the query `q`, or None for packets that aren't queries. A `.test` name gets 127.0.0.1 for A, ::1
/// for AAAA when the proxy listens on ::1 (`v6`), and no answers for anything else, never NXDOMAIN.
pub fn answer(q: &[u8], v6: bool) -> Option<Vec<u8>> {
    if q.len() < 12 || q[2] & 0x80 != 0 {
        return None;
    }
    let reply = |rcode: u8, question: &[u8], rdata: Option<(u16, &[u8])>| {
        // Recursion desired is copied; the answer is authoritative.
        let mut r = vec![q[0], q[1], 0x84 | (q[2] & 0x01), rcode, 0, u8::from(!question.is_empty()), 0, u8::from(rdata.is_some()), 0, 0, 0, 0];
        r.extend_from_slice(question);
        if let Some((qtype, data)) = rdata {
            r.extend_from_slice(&[0xc0, 12]);
            r.extend_from_slice(&qtype.to_be_bytes());
            r.extend_from_slice(&1u16.to_be_bytes());
            r.extend_from_slice(&TTL.to_be_bytes());
            r.extend_from_slice(&(data.len() as u16).to_be_bytes());
            r.extend_from_slice(data);
        }
        r
    };
    if (q[2] >> 3) & 0x0f != 0 {
        return Some(reply(NOTIMP, &[], None));
    }
    let Some((end, test, qtype, qclass)) = question(q).filter(|_| q[4..6] == [0, 1]) else {
        return Some(reply(FORMERR, &[], None));
    };
    let question = &q[12..end];
    if !test {
        return Some(reply(REFUSED, question, None));
    }
    let rdata: Option<(u16, &[u8])> = match (qtype, qclass) {
        (1, 1) => Some((1, &[127, 0, 0, 1])),
        (28, 1) if v6 => Some((28, &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
        _ => None,
    };
    Some(reply(0, question, rdata))
}

/// A query for `name` of type `qtype`.
pub fn query(name: &str, qtype: u16) -> Vec<u8> {
    let mut q = vec![0x54, 0x4b, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in name.split('.').filter(|l| !l.is_empty()) {
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0);
    q.extend_from_slice(&qtype.to_be_bytes());
    q.extend_from_slice(&1u16.to_be_bytes());
    q
}

pub async fn serve(socket: UdpSocket, v6: bool) {
    let mut buf = [0u8; 1500];
    loop {
        // Windows reports an earlier reply's unreachable port as a receive error, so errors only skip a packet.
        let Ok((n, from)) = socket.recv_from(&mut buf).await else { continue };
        if let Some(reply) = answer(&buf[..n], v6) {
            let _ = socket.send_to(&reply, from).await;
        }
    }
}

/// Whether whatever holds `port` answers `.test` names with this computer, as another Tusk does.
pub async fn probe(port: u16) -> bool {
    let ask = async {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.ok()?;
        socket.send_to(&query("tusk-probe.test", 1), SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await.ok()?;
        let mut buf = [0u8; 512];
        let n = socket.recv(&mut buf).await.ok()?;
        let r = &buf[..n];
        Some(r.len() > 12 && r[6..8] != [0, 0] && r.ends_with(&[127, 0, 0, 1]))
    };
    tokio::time::timeout(Duration::from_secs(1), ask).await.ok().flatten().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rcode(r: &[u8]) -> u8 {
        r[3] & 0x0f
    }

    fn answers(r: &[u8]) -> u16 {
        u16::from_be_bytes([r[6], r[7]])
    }

    #[test]
    fn answers_test_names() {
        let r = answer(&query("shop.test", 1), false).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 1));
        assert!(r.ends_with(&[127, 0, 0, 1]));
        assert_eq!(&r[..2], &[0x54, 0x4b]);

        let r = answer(&query("API.Shop.TEST", 1), false).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 1));
        let r = answer(&query("test", 1), false).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 1));

        let r = answer(&query("shop.test", 28), false).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 0));
        let r = answer(&query("shop.test", 28), true).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 1));
        assert!(r.ends_with(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));

        let r = answer(&query("shop.test", 65), true).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (0, 0));
    }

    #[test]
    fn refuses_other_names() {
        let r = answer(&query("example.com", 1), false).unwrap();
        assert_eq!((rcode(&r), answers(&r)), (REFUSED, 0));
        let r = answer(&query("test.example.com", 1), false).unwrap();
        assert_eq!(rcode(&r), REFUSED);
    }

    #[test]
    fn survives_bad_packets() {
        let q = query("shop.test", 1);
        for n in 0..q.len() {
            let _ = answer(&q[..n], false);
        }
        assert_eq!(answer(&q[..q.len() - 1], false).map(|r| rcode(&r)), Some(FORMERR));
        let mut seed = 0x2545f491u32;
        for _ in 0..2000 {
            let packet: Vec<u8> = (0..(seed % 80) as usize)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    seed as u8
                })
                .collect();
            let _ = answer(&packet, true);
        }
        let mut pointer = q.clone();
        pointer[12] = 0xc0;
        assert_eq!(answer(&pointer, false).map(|r| rcode(&r)), Some(FORMERR));
        let mut reply = q;
        reply[2] |= 0x80;
        assert!(answer(&reply, false).is_none());
    }
}
