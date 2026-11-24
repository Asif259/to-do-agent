export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="site-footer-copy">
          © {year} To-Do Agent. All rights reserved.
        </p>
        <p className="site-footer-credit">
          Designed & built by{" "}
          <a
            href="https://ashrafulasif.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="site-footer-link"
          >
            Ashraful Asif
          </a>
        </p>
      </div>
    </footer>
  );
}
