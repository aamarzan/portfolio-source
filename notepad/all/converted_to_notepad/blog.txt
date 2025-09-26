document.addEventListener('DOMContentLoaded', () => {
    
    // --- Scroll Animation for Blog Cards ---
    const cards = document.querySelectorAll('.blog-card');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                // This adds a slight delay to each card for a staggered effect
                setTimeout(() => {
                    entry.target.classList.add('is-visible');
                }, index * 100);
                
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1
    });

    cards.forEach(card => {
        observer.observe(card);
    });
});