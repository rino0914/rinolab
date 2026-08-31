#include "core/gthread.h"
#include "const/types.h"

class Tramakethread : public Gthread{
    private:
    int num;

    public:
    Tramakethread() : Gthread(true, true, "tramakethread"){};

    virtual bool onThreadLoop();

};
