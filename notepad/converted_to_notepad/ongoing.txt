document.addEventListener('DOMContentLoaded', function() {
    const imageContainers = document.querySelectorAll('.image-container');
    
    imageContainers.forEach(container => {
        container.addEventListener('click', function(event) {
            if (event.target.classList.contains('project-image')) {
                const imageSrc = event.target.src;
                const linkUrl = container.getAttribute('data-link');
                
                const modal = document.createElement('div');
                modal.className = 'image-modal';
                modal.innerHTML = `
                    <span class="close-button">&times;</span>
                    <img src="${imageSrc}" alt="Full size project image">
                    <div class="modal-text">Go to <i>Link</i></div>
                `;
                document.body.appendChild(modal);
                document.body.style.overflow = 'hidden';

                const closeModal = () => {
                    modal.remove();
                    document.body.style.overflow = '';
                };

                modal.querySelector('.close-button').addEventListener('click', closeModal);
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        closeModal();
                    }
                });

                modal.querySelector('.modal-text').addEventListener('click', () => {
                    window.open(linkUrl, '_blank');
                    closeModal();
                });
            }
        });
    });
});